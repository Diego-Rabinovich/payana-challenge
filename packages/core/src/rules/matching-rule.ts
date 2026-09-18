import type { BusinessCalendar } from '../domain/business-calendar.js';
import type { Evidence } from '../domain/evidence.js';
import type { MatchAmounts } from '../domain/match-result.js';
import type { Movement } from '../domain/movement.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';

export interface MatchingContext {
  readonly calendar: BusinessCalendar;
  readonly ruleSet: RuleSet;
  /** Which channel we are reconciling, e.g. 'wompi'. */
  readonly channel: string;
}

/** A bank credit a rule considers plausible, with the checks it ran. */
export interface Candidate {
  readonly deposit: Movement;
  readonly evidence: readonly Evidence[];
  readonly amounts: MatchAmounts;
}

/**
 * A strategy for finding the bank credit that settles a batch.
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
