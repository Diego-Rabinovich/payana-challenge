import { evidence } from '../domain/evidence.js';
import type { Movement } from '../domain/movement.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import type { Candidate, MatchingContext, MatchingRule } from './matching-rule.js';
import {
  amountEvidence,
  dateEvidence,
  descriptorEvidence,
  describeAmounts,
  eligibleDeposits,
  identityEvidence,
} from './settlement-evidence.js';

/**
 * The primary rule: one closed batch settles as one credit, on schedule.
 *
 * For Wompi that reads as the brief states it — a day's charges arrive the
 * next business day — and this rule is what makes the result explainable:
 * "the 31 Dec batch settled on 2 Jan, T+1 because the 1st was a holiday" is
 * something a CFO can check against a statement.
 *
 * The cadence is no longer in the name because it is no longer in the code.
 * A channel that cuts weekly produces weekly batches and this rule still
 * applies unchanged; what "on schedule" means comes from the channel's
 * policy. Arithmetic search is the fallback, never the first move. See
 * ADR-0004.
 */
export class ScheduledSettlementRule implements MatchingRule {
  readonly id = 'SCHEDULED_SETTLEMENT';
  readonly version = 2;

  evaluate(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): Candidate[] {
    return eligibleDeposits(batch, deposits, context).map((deposit) =>
      this.assess(batch, deposit, context),
    );
  }

  private assess(
    batch: SettlementBatch,
    deposit: Movement,
    { calendar, ruleSet, channel, policy }: MatchingContext,
  ): Candidate {
    const deposits = [deposit];
    const amounts = describeAmounts(batch, deposit.amount);

    return {
      deposits,
      amounts,
      evidence: [
        amountEvidence(batch, amounts, ruleSet, channel),
        dateEvidence(batch, deposits, calendar, policy),
        descriptorEvidence(deposits, ruleSet, channel),
        identityEvidence(batch, ruleSet),
        // The shape the brief describes, stated as evidence rather than
        // assumed. A settlement that did not arrive this way forfeits the
        // weight, which is what keeps a split visibly less certain than
        // the thing it is standing in for.
        evidence('SETTLEMENT_SINGLE_CREDIT', 'INTEGRITY', true, {
          expected: '1 acreditación',
          observed: `${deposit.valueDate.toString()} ${deposit.amount.toString()}`,
        }),
      ],
    };
  }
}
