import type { BusinessCalendar } from '../domain/business-calendar.js';
import type { Evidence } from '../domain/evidence.js';
import type { MovementId } from '../domain/ids.js';
import type { MatchAmounts } from '../domain/match-result.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { SettlementPolicy } from '../domain/settlement-policy.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';

export interface MatchingContext {
  readonly calendar: BusinessCalendar;
  readonly ruleSet: RuleSet;
  /** Which channel we are reconciling, e.g. 'wompi'. */
  readonly channel: string;
  /** How this channel batches and how long it then takes to pay. */
  readonly policy: SettlementPolicy;
}

/**
 * A settlement a rule considers plausible, with the checks it ran.
 *
 * `deposits` is a list because the real relation is N:M — a batch can arrive
 * split across two transfers, and two batches can arrive as one. Modelling it
 * as one credit and calling the remainder "unmatched" would be fitting the
 * domain to the code.
 *
 * The list is almost always one long, and that is the point: the priority
 * rule is still a single credit on the next business day, exactly as the
 * brief describes. Anything else has to say so in its evidence, which is what
 * `SETTLEMENT_SPLIT` is for. A difference is allowed; an unexplained
 * difference is not.
 */
export interface Candidate {
  readonly deposits: readonly Movement[];
  readonly evidence: readonly Evidence[];
  readonly amounts: MatchAmounts;
}

export function depositIdsOf(candidate: Candidate): MovementId[] {
  return candidate.deposits.map((deposit) => deposit.id);
}

export function depositTotalOf(candidate: Candidate): Money {
  return Money.sum(candidate.deposits.map((deposit) => deposit.amount));
}

/** Stable identity for a candidate, so ordering and lookups are reproducible. */
export function candidateKey(candidate: Candidate): string {
  return depositIdsOf(candidate).slice().sort().join('+');
}

/**
 * A strategy for finding the bank credits that settle a batch.
 *
 * Adding one is a new class plus a ruleset entry; the engine does not change.
 * Rules deliberately cannot see each other's candidates, and none of them
 * decides uniqueness — that is a property of the whole field, so the matcher
 * adds it after all rules have run. See ADR-0004.
 */
export interface MatchingRule {
  readonly id: string;
  readonly version: number;
  evaluate(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): Candidate[];
}
