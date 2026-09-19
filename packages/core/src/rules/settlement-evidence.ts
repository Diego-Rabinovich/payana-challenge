import { Temporal } from '@js-temporal/polyfill';
import { type Evidence, evidence } from '../domain/evidence.js';
import type { MatchAmounts } from '../domain/match-result.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { RuleSet } from '../domain/ruleset.js';
import { type SettlementBatch, identityHolds, totalDeductions } from '../domain/settlement-batch.js';
import type { SettlementPolicy } from '../domain/settlement-policy.js';
import type { MatchingContext } from './matching-rule.js';

/**
 * The checks every settlement rule runs, so that two rules reaching the same
 * conclusion produce the same evidence.
 *
 * Extracted when the split rule appeared: if each rule wrote its own amount
 * check, a match found by a different route would be explained in different
 * words, and the evidence codes would stop being a closed vocabulary in
 * practice even while remaining one in the type system.
 */

export interface DepositWindow {
  readonly from: Temporal.PlainDate;
  readonly to: Temporal.PlainDate;
}

export function isCredit(movement: Movement): boolean {
  return movement.amount.isPositive();
}

export function withinWindow(date: Temporal.PlainDate, window: DepositWindow): boolean {
  return (
    Temporal.PlainDate.compare(date, window.from) >= 0 &&
    Temporal.PlainDate.compare(date, window.to) <= 0
  );
}

/** The credits a batch could conceivably have settled into, before amounts. */
export function eligibleDeposits(
  batch: SettlementBatch,
  deposits: readonly Movement[],
  { calendar, ruleSet, channel, policy }: MatchingContext,
): Movement[] {
  const window = windowFor(batch, calendar, policy);
  return deposits
    .filter(isCredit)
    .filter((deposit) => withinWindow(deposit.valueDate, window))
    // A credit that names someone else's counterparty is not a weak
    // candidate, it is a different payment. Letting it compete would let an
    // unrelated transfer of the right size steal a settlement.
    .filter((deposit) => !ruleSet.isForeignCounterparty(channel, deposit.counterparty));
}

export function windowFor(
  batch: SettlementBatch,
  calendar: MatchingContext['calendar'],
  policy: SettlementPolicy,
): DepositWindow {
  const { fromBusinessDays, toBusinessDays } = policy.window;
  return calendar.settlementWindow(batch.batchDate, fromBusinessDays, toBusinessDays);
}

/**
 * What a credit would have to total for this batch, and how far off it may be.
 *
 * Exact when the source reported its deductions. When it reported none — which
 * is Wompi's case — the expectation is not `expectedNet` at all: that figure is
 * the gross, and no credit net of fees will ever equal it. The honest target is
 * the gross less a plausible deduction rate, with the width of the plausible
 * band as the tolerance.
 *
 * Searching on `expectedNet` regardless is exactly the bug that made the split
 * rule fire zero times against four months of real statements.
 */
export function expectedTotal(
  batch: SettlementBatch,
  ruleSet: RuleSet,
): { targetCents: number; toleranceCents: number } {
  if (batch.deductions.length > 0) {
    return {
      targetCents: batch.expectedNet.cents,
      toleranceCents: ruleSet.config.subsetSum.toleranceCents,
    };
  }

  const [low, high] = ruleSet.config.tolerances.impliedFeeRateBand;
  const midpoint = (low + high) / 2;
  return {
    targetCents: Math.round(batch.gross.cents * (1 - midpoint)),
    toleranceCents: Math.round((batch.gross.cents * (high - low)) / 2),
  };
}

export function describeAmounts(batch: SettlementBatch, observedNet: Money): MatchAmounts {
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
export function amountEvidence(
  batch: SettlementBatch,
  amounts: MatchAmounts,
  ruleSet: RuleSet,
): Evidence {
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

/**
 * How far the money landed from the day the policy says it should have.
 *
 * `from` is the expected day — T+1 business day for Wompi, which is what the
 * brief states — and it is the only one that earns the full weight. Landing
 * later still inside the window is a match, but a visibly weaker one, which
 * is what makes a late settlement explainable instead of invisible.
 */
export function dateEvidence(
  batch: SettlementBatch,
  deposits: readonly Movement[],
  calendar: MatchingContext['calendar'],
  policy: SettlementPolicy,
): Evidence {
  const { fromBusinessDays, toBusinessDays } = policy.window;
  const arrival = earliestDate(deposits);
  const gap = calendar.businessDaysBetween(batch.batchDate, arrival);
  const context = {
    expected: `T+${fromBusinessDays} business days`,
    observed: `T+${gap} (${deposits.map((deposit) => deposit.valueDate.toString()).join(', ')})`,
  };

  if (gap === fromBusinessDays) return evidence('DATE_T1_EXACT', 'DATE', true, context);
  if (gap >= fromBusinessDays && gap <= toBusinessDays) {
    return evidence('DATE_IN_WINDOW', 'DATE', true, context);
  }
  return evidence('DATE_OUT_OF_WINDOW', 'DATE', false, context);
}

export function descriptorEvidence(
  deposits: readonly Movement[],
  ruleSet: RuleSet,
  channel: string,
): Evidence {
  const observed = deposits
    .map((deposit) => deposit.counterparty ?? deposit.description)
    .join(' | ');
  const context = { expected: channel, observed };

  // Every credit must name the channel. One anonymous transfer inside an
  // otherwise clean set is exactly the case worth flagging.
  const all = deposits.every((deposit) =>
    ruleSet.isChannelCounterparty(channel, deposit.counterparty),
  );
  return all
    ? evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true, context)
    : evidence('DESCRIPTOR_FOREIGN', 'DESCRIPTOR', false, context);
}

export function identityEvidence(batch: SettlementBatch, ruleSet: RuleSet): Evidence {
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

function earliestDate(deposits: readonly Movement[]): Temporal.PlainDate {
  return deposits.reduce(
    (earliest, deposit) =>
      Temporal.PlainDate.compare(deposit.valueDate, earliest) < 0 ? deposit.valueDate : earliest,
    deposits[0]!.valueDate,
  );
}
