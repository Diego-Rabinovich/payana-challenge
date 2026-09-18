import type { Temporal } from '@js-temporal/polyfill';
import type { Confidence, MatchBand } from './confidence.js';
import type { EvidenceCode } from './evidence.js';
import type { BatchId, MatchId, MovementId, RunId } from './ids.js';
import type { Money } from './money.js';

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

/** A candidate that lost, and the check that cost it the match. */
export interface RejectedCandidate {
  readonly movementId: MovementId;
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
  readonly right: { readonly movementId: MovementId } | null;
  readonly rule: { readonly id: string; readonly version: number };
  readonly amounts: MatchAmounts;
  readonly window: {
    readonly from: Temporal.PlainDate;
    readonly to: Temporal.PlainDate;
    readonly basis: 'BUSINESS_DAYS';
  };
  readonly confidence: Confidence;
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
  readonly matches: readonly MatchResult[];
  readonly unattributed: readonly UnattributedCredit[];
  readonly totals: {
    readonly batches: number;
    readonly byStatus: Readonly<Partial<Record<MatchStatus, number>>>;
    readonly expectedNet: Money;
    readonly observedNet: Money;
    readonly unexplained: Money;
  };
}
