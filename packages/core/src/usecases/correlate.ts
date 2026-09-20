import type { Evidence } from '../domain/evidence.js';
import { evidence } from '../domain/evidence.js';
import type { MatchId, MovementId } from '../domain/ids.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { MatchResult } from '../domain/match-result.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import { attribute } from './trace-movement.js';

/**
 * The brief's first suggested primitive: given one channel movement and one
 * bank movement, are they related, and why?
 *
 * The reconciliation answers this at the level of a batch, which is the right
 * unit to decide it — a single $100 payment never appears in the bank on its
 * own. But "is this payment inside that deposit" is a question a person
 * actually asks, and answering it by making them read a batch id and do the
 * arithmetic is not answering it.
 *
 * So this composes what already exists rather than recomputing anything: the
 * batch the charge belongs to, the match that batch got, and this charge's
 * pro-rata share of what was credited. No new judgement is made here, which is
 * why an unrelated pair comes back with a reason rather than with a score.
 */

export type CorrelationVerdict =
  /** The charge settled inside that credit. */
  | 'SETTLED_IN'
  /** The charge's batch matched a different credit. */
  | 'SETTLED_ELSEWHERE'
  /** The batch never matched anything, so nothing can be said about this pair. */
  | 'UNSETTLED'
  /** The two belong to batches that have nothing to do with each other. */
  | 'UNRELATED';

export interface Correlation {
  readonly verdict: CorrelationVerdict;
  readonly channelMovementId: MovementId;
  readonly bankMovementId: MovementId;
  readonly batchId?: SettlementBatch['id'];
  readonly matchId?: MatchId;
  /** This charge's share of what actually reached the bank. */
  readonly attributedNet?: Money;
  /** The share as a fraction of the batch, so a reader can check the split. */
  readonly shareOfBatch?: number;
  /** The evidence of the underlying match, unchanged. */
  readonly evidence: readonly Evidence[];
}

export interface CorrelateInput {
  readonly charge: Movement;
  readonly credit: Movement;
  readonly batch?: SettlementBatch;
  readonly charges: readonly Movement[];
  readonly match?: MatchResult;
}

export function correlate(input: CorrelateInput): Correlation {
  const { charge, credit, batch, charges, match } = input;
  const ids = { channelMovementId: charge.id, bankMovementId: credit.id };

  if (!batch) {
    return {
      ...ids,
      verdict: 'UNRELATED',
      evidence: [
        evidence('MISSING_IN_LEDGER', 'ERP', false, {
          detail: 'el pago no pertenece a ninguna liquidación de este período',
        }),
      ],
    };
  }

  if (!match?.right) {
    return {
      ...ids,
      verdict: 'UNSETTLED',
      batchId: batch.id,
      ...(match ? { matchId: match.id } : {}),
      evidence: match?.confidence.components ?? [],
    };
  }

  const settled = match.right.movementIds.includes(credit.id);
  const attributedNet = attribute(charge, match.amounts.observedNet ?? batch.expectedNet, charges);

  return {
    ...ids,
    verdict: settled ? 'SETTLED_IN' : 'SETTLED_ELSEWHERE',
    batchId: batch.id,
    matchId: match.id,
    ...(settled
      ? {
          attributedNet,
          shareOfBatch: batch.gross.isPositive()
            ? Math.abs(charge.amount.cents) / batch.gross.cents
            : 0,
        }
      : {}),
    // The explanation is the match's own evidence. Inventing a second one here
    // would let this primitive and the reconciliation screen disagree.
    evidence: match.confidence.components,
  };
}
