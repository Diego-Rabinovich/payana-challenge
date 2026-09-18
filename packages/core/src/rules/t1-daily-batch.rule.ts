import { Temporal } from '@js-temporal/polyfill';
import { type Evidence, evidence } from '../domain/evidence.js';
import type { MatchAmounts } from '../domain/match-result.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { RuleSet } from '../domain/ruleset.js';
import {
  type SettlementBatch,
  identityHolds,
  totalDeductions,
} from '../domain/settlement-batch.js';
import type { Candidate, MatchingContext, MatchingRule } from './matching-rule.js';

/**
 * The primary rule: a day's charges settle as one credit, T+1 business day.
 *
 * This is the structural hypothesis the business actually follows, and it is
 * what makes the result explainable — "the 31 Dec batch settled on 2 Jan,
 * T+1 because the 1st was a holiday" is something a CFO can check. Arithmetic
 * search is the fallback, not the first move. See ADR-0004.
 */
export class T1DailyBatchRule implements MatchingRule {
  readonly id = 'T1_DAILY_BATCH';
  readonly version = 1;

  evaluate(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): Candidate[] {
    const { calendar, ruleSet, channel } = context;
    const { fromBusinessDays, toBusinessDays } = ruleSet.config.settlementWindow;
    const window = calendar.settlementWindow(batch.batchDate, fromBusinessDays, toBusinessDays);

    return deposits
      .filter((deposit) => isCredit(deposit))
      .filter((deposit) => withinWindow(deposit.valueDate, window))
      // A credit that names someone else's counterparty is not a weak
      // candidate, it is a different payment. Letting it compete would let an
      // unrelated transfer of the right size steal a settlement.
      .filter((deposit) => !ruleSet.isForeignCounterparty(channel, deposit.counterparty))
      .map((deposit) => this.assess(batch, deposit, context));
  }

  private assess(
    batch: SettlementBatch,
    deposit: Movement,
    { calendar, ruleSet, channel }: MatchingContext,
  ): Candidate {
    const amounts = describeAmounts(batch, deposit);
    return {
      deposit,
      amounts,
      evidence: [
        amountEvidence(batch, amounts, ruleSet),
        dateEvidence(batch, deposit, calendar, ruleSet),
        descriptorEvidence(deposit, ruleSet, channel),
        identityEvidence(batch, ruleSet),
      ],
    };
  }
}

function isCredit(movement: Movement): boolean {
  return movement.amount.isPositive();
}

function withinWindow(
  date: Temporal.PlainDate,
  window: { from: Temporal.PlainDate; to: Temporal.PlainDate },
): boolean {
  return (
    Temporal.PlainDate.compare(date, window.from) >= 0 &&
    Temporal.PlainDate.compare(date, window.to) <= 0
  );
}

function describeAmounts(batch: SettlementBatch, deposit: Movement): MatchAmounts {
  const observedNet = deposit.amount;
  const deductions = totalDeductions(batch.deductions);
  const gap = batch.gross.minus(observedNet);

  return {
    gross: batch.gross,
    deductions,
    expectedNet: batch.expectedNet,
    observedNet,
    delta: observedNet.minus(batch.expectedNet),
    ...(batch.gross.isPositive() ? { impliedDeductionRate: gap.cents / batch.gross.cents } : {}),
  };
}

/**
 * Amount checks, in descending order of how much they tell us.
 *
 * Exactness is strong evidence. Rounding slack is weaker. A deduction we had
 * to infer from the gap is weaker still, and only admissible when the source
 * reported none — otherwise we would be explaining away a real discrepancy.
 */
function amountEvidence(batch: SettlementBatch, amounts: MatchAmounts, ruleSet: RuleSet): Evidence {
  const delta = amounts.delta ?? Money.zero();
  const context = {
    expected: amounts.expectedNet.toString(),
    observed: (amounts.observedNet ?? Money.zero()).toString(),
  };

  if (delta.isZero()) {
    return evidence('AMOUNT_EXACT', 'AMOUNT', true, context);
  }
  if (Math.abs(delta.cents) <= ruleSet.config.tolerances.roundingCents) {
    return evidence('AMOUNT_WITHIN_ROUNDING', 'AMOUNT', true, {
      ...context,
      detail: `delta ${delta.toString()}`,
    });
  }

  const reportedNothing = batch.deductions.length === 0;
  const rate = amounts.impliedDeductionRate ?? Number.NaN;
  const [low, high] = ruleSet.config.tolerances.impliedFeeRateBand;
  if (reportedNothing && rate >= low && rate <= high) {
    return evidence('IMPLIED_FEE_IN_BAND', 'AMOUNT', true, {
      ...context,
      detail: `implied deduction rate ${(rate * 100).toFixed(2)}%`,
    });
  }

  return evidence('AMOUNT_MISMATCH', 'AMOUNT', false, {
    ...context,
    detail: `delta ${delta.toString()}`,
  });
}

function dateEvidence(
  batch: SettlementBatch,
  deposit: Movement,
  calendar: { businessDaysBetween(a: Temporal.PlainDate, b: Temporal.PlainDate): number },
  ruleSet: RuleSet,
): Evidence {
  const { fromBusinessDays, toBusinessDays } = ruleSet.config.settlementWindow;
  const gap = calendar.businessDaysBetween(batch.batchDate, deposit.valueDate);
  const context = {
    expected: `T+${fromBusinessDays} business days`,
    observed: `T+${gap} (${deposit.valueDate.toString()})`,
  };

  if (gap === fromBusinessDays) return evidence('DATE_T1_EXACT', 'DATE', true, context);
  if (gap >= fromBusinessDays && gap <= toBusinessDays) {
    return evidence('DATE_IN_WINDOW', 'DATE', true, context);
  }
  return evidence('DATE_OUT_OF_WINDOW', 'DATE', false, context);
}

function descriptorEvidence(deposit: Movement, ruleSet: RuleSet, channel: string): Evidence {
  const context = { expected: channel, observed: deposit.counterparty ?? deposit.description };

  return ruleSet.isChannelCounterparty(channel, deposit.counterparty)
    ? evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true, context)
    : evidence('DESCRIPTOR_FOREIGN', 'DESCRIPTOR', false, context);
}

function identityEvidence(batch: SettlementBatch, ruleSet: RuleSet): Evidence {
  const holds = identityHolds(batch, ruleSet.config.tolerances.identityCents);
  const context = {
    expected: batch.gross.toString(),
    observed: batch.expectedNet.plus(totalDeductions(batch.deductions)).toString(),
  };

  // With nothing reported there is no identity to check, so this cannot pass.
  // The match then tops out below 100, which is the honest outcome: we know
  // less about it than about one whose breakdown we could verify.
  if (batch.deductions.length === 0) {
    return evidence('IDENTITY_BROKEN', 'INTEGRITY', false, {
      ...context,
      detail: 'source reported no deductions to verify',
    });
  }
  return holds
    ? evidence('IDENTITY_HOLDS', 'INTEGRITY', true, context)
    : evidence('IDENTITY_BROKEN', 'INTEGRITY', false, context);
}
