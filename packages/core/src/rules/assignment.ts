import { type Confidence, scoreMatch } from '../domain/confidence.js';
import { type Evidence, evidence } from '../domain/evidence.js';
import type { BatchId } from '../domain/ids.js';
import type { RejectedCandidate } from '../domain/match-result.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import type { Candidate } from './matching-rule.js';

export interface BatchAssignment {
  readonly batch: SettlementBatch;
  readonly winner?: Candidate;
  readonly confidence: Confidence;
  readonly alternatives: readonly RejectedCandidate[];
}

/**
 * Decides which credit settles which batch.
 *
 * Not a 1:1 walk by date. Two batches can want the same credit, a day can
 * carry two credits, and a quiet day can be followed by a double one — so it
 * is an assignment over the whole field, resolved by a stable greedy pass:
 * the strongest pair wins, both sides are consumed, and the next strongest
 * gets its turn.
 *
 * Uniqueness is decided here rather than inside a rule, because no rule can
 * see the other candidates. A runner-up within `ambiguityDelta` forces
 * AMBIGUOUS however high the winner scored: ambiguity gets reported, never
 * quietly resolved. See ADR-0005.
 */
export function assignCandidates(
  batches: readonly SettlementBatch[],
  candidatesByBatch: ReadonlyMap<BatchId, readonly Candidate[]>,
  ruleSet: RuleSet,
): BatchAssignment[] {
  const provisional = new Map<string, number>();
  const pairs: Array<{ batch: SettlementBatch; candidate: Candidate; score: number }> = [];

  for (const batch of batches) {
    for (const candidate of candidatesByBatch.get(batch.id) ?? []) {
      const score = scoreMatch(candidate.evidence, ruleSet.scoring).score;
      provisional.set(key(batch.id, candidate), score);
      pairs.push({ batch, candidate, score });
    }
  }

  // Deterministic ordering: the same inputs must always produce the same
  // assignment, ties included, or the run is not reproducible.
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      compare(a.batch.id, b.batch.id) ||
      compare(a.candidate.deposit.id, b.candidate.deposit.id),
  );

  const takenBatches = new Set<BatchId>();
  const takenDeposits = new Set<string>();
  const winners = new Map<BatchId, Candidate>();

  for (const pair of pairs) {
    if (takenBatches.has(pair.batch.id) || takenDeposits.has(pair.candidate.deposit.id)) continue;
    takenBatches.add(pair.batch.id);
    takenDeposits.add(pair.candidate.deposit.id);
    winners.set(pair.batch.id, pair.candidate);
  }

  return batches.map((batch) =>
    settle(batch, candidatesByBatch.get(batch.id) ?? [], winners.get(batch.id), provisional, ruleSet),
  );
}

function settle(
  batch: SettlementBatch,
  candidates: readonly Candidate[],
  winner: Candidate | undefined,
  provisional: ReadonlyMap<string, number>,
  ruleSet: RuleSet,
): BatchAssignment {
  if (winner === undefined) {
    return {
      batch,
      confidence: scoreMatch(unmatchedEvidence(candidates), ruleSet.scoring),
      alternatives: candidates.map((candidate) =>
        reject(candidate, provisional.get(key(batch.id, candidate)) ?? 0),
      ),
    };
  }

  const winnerScore = provisional.get(key(batch.id, winner)) ?? 0;
  const others = candidates.filter((candidate) => candidate !== winner);
  const runnerUpScore = Math.max(
    0,
    ...others.map((candidate) => provisional.get(key(batch.id, candidate)) ?? 0),
  );
  // Compared before the uniqueness point is awarded, so both sides are on the
  // same scale — the runner-up would have earned it too, had it won.
  const contested = others.length > 0 && winnerScore - runnerUpScore <= ruleSet.config.ambiguityDelta;

  const uniqueness = contested
    ? evidence('COMPETING_CANDIDATE', 'UNIQUENESS', false, {
        detail: `runner-up scored ${runnerUpScore}`,
      })
    : evidence('UNIQUE_CANDIDATE', 'UNIQUENESS', true);

  return {
    batch,
    winner,
    confidence: scoreMatch([...winner.evidence, uniqueness], ruleSet.scoring, { contested }),
    alternatives: others.map((candidate) =>
      reject(candidate, provisional.get(key(batch.id, candidate)) ?? 0, contested),
    ),
  };
}

/** Why a candidate lost: the first check it failed, or simply being outscored. */
function reject(candidate: Candidate, score: number, contested = false): RejectedCandidate {
  const failed = candidate.evidence.find((item) => !item.passed);
  return {
    movementId: candidate.deposit.id,
    score,
    rejectedBecause: failed?.code ?? (contested ? 'COMPETING_CANDIDATE' : 'AMOUNT_MISMATCH'),
  };
}

/**
 * A batch with no credit still carries evidence: keeping the failed checks of
 * the nearest candidates is what turns "unmatched" into something a person can
 * act on.
 */
function unmatchedEvidence(candidates: readonly Candidate[]): Evidence[] {
  if (candidates.length === 0) {
    return [
      evidence('DATE_OUT_OF_WINDOW', 'DATE', false, {
        detail: 'no bank credit fell inside the settlement window',
      }),
    ];
  }
  return candidates[0]!.evidence.filter((item) => !item.passed);
}

function key(batchId: BatchId, candidate: Candidate): string {
  return `${batchId}|${candidate.deposit.id}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

