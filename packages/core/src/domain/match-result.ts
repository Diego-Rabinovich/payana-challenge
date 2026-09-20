import type { Temporal } from '@js-temporal/polyfill';
import type { Confidence, MatchBand } from './confidence.js';
import type { EvidenceCode } from './evidence.js';
import type { BatchId, MatchId, MovementId, RunId } from './ids.js';
import type { Money } from './money.js';
import type { RateCalibration } from './rate-calibration.js';

/**
 * The conclusion of a channel-to-bank comparison.
 *
 * The shape is the brief's explainability checklist, field by field: which
 * movements it relates, which rule it used, which amount adjustment it
 * applied, which window it considered, how confident it is, and what it
 * discarded. A conclusion that cannot answer all six is not reportable.
 */

export type MatchStatus = MatchBand | 'UNRESOLVED_COMBINATORIAL';

export interface MatchAmounts {
  readonly gross: Money;
  readonly deductions: Money;
  readonly expectedNet: Money;
  readonly observedNet?: Money;
  /** observed − expected. Positive means the bank received more than we expected. */
  readonly delta?: Money;
  /** Total deduction rate implied by the gap, when the source reported none. */
  readonly impliedDeductionRate?: number;
}

/**
 * The breakdown recovered from the gap when the gateway did not report one.
 *
 * Kept apart from `amounts` on purpose: a reader has to be able to tell a
 * figure the source stated from one the system computed, and folding these
 * into the expectation would erase that distinction. See ADR-0013.
 */
export interface DerivedDeductions {
  readonly fee: Money;
  readonly tax: Money;
  readonly withholding: Money;
  readonly total: Money;
  readonly impliedRate: number;
  /** Whether the split is consistent with the statutory VAT rate. */
  readonly consistent: boolean;
}

/** A candidate that lost, and the check that cost it the match. */
export interface RejectedCandidate {
  /** The credits it proposed. More than one when it was a split. */
  readonly movementIds: readonly MovementId[];
  readonly score: number;
  readonly rejectedBecause: EvidenceCode;
}

export interface MatchResult {
  readonly id: MatchId;
  readonly runId?: RunId;
  /** Without this, the result cannot be reproduced. */
  readonly rulesetVersion: string;
  readonly kind: 'CHANNEL_TO_BANK';
  readonly status: MatchStatus;
  readonly left: {
    readonly batchId: BatchId;
    readonly batchDate: Temporal.PlainDate;
    readonly chargeIds: readonly MovementId[];
  };
  /**
   * The credits that settled it. Usually one; several when the batch arrived
   * split, which the evidence then says out loud. Null when nothing matched.
   */
  readonly right: { readonly movementIds: readonly MovementId[] } | null;
  readonly rule: { readonly id: string; readonly version: number };
  readonly amounts: MatchAmounts;
  readonly window: {
    readonly from: Temporal.PlainDate;
    readonly to: Temporal.PlainDate;
    readonly basis: 'BUSINESS_DAYS';
  };
  readonly confidence: Confidence;
  /** Present when the gateway reported no breakdown and one was derived. */
  readonly derivedDeductions?: DerivedDeductions;
  /** Everything the matcher considered and set aside, with the reason. */
  readonly alternatives: readonly RejectedCandidate[];
}

/** A bank credit no batch claimed, kept visible rather than dropped. */
export interface UnattributedCredit {
  readonly movementId: MovementId;
  readonly valueDate: Temporal.PlainDate;
  readonly amount: Money;
  readonly counterparty?: string;
  readonly description: string;
  readonly reason: EvidenceCode;
}

export interface ReconciliationReport {
  readonly runId?: RunId;
  readonly rulesetVersion: string;
  /**
   * What this run measured the channel to usually charge.
   *
   * Part of the result rather than of the configuration, so a run can be
   * read years later against the distribution it was actually scored
   * against. Absent when too few settlements matched to say anything.
   */
  readonly calibration?: RateCalibration;
  readonly matches: readonly MatchResult[];
  readonly unattributed: readonly UnattributedCredit[];
  readonly totals: {
    readonly batches: number;
    readonly byStatus: Readonly<Partial<Record<MatchStatus, number>>>;
    readonly gross: Money;
    /**
     * What the gateway kept. Reported where the source states it, derived from
     * the gap where it does not — which for Wompi is always, and leaving it at
     * zero made the panel claim the whole commission was unexplained money.
     */
    readonly deductions: Money;
    readonly deductionsAreDerived: boolean;
    /** gross − deductions: what should have reached the bank. */
    readonly expectedNet: Money;
    readonly observedNet: Money;
    readonly unexplained: Money;
  };
}
