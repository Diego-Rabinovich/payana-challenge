import { type Confidence, disqualifiedBy, scoreMatch } from '../domain/confidence.js';
import { type Evidence, evidence } from '../domain/evidence.js';
import type { BatchId } from '../domain/ids.js';
import type { RejectedCandidate } from '../domain/match-result.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import { type Candidate, candidateKey, depositIdsOf } from './matching-rule.js';

export interface BatchAssignment {
  readonly batch: SettlementBatch;
  readonly winner?: Candidate;
  readonly confidence: Confidence;
  readonly alternatives: readonly RejectedCandidate[];
}

/**
 * Decides which credit settles which batch.
 *
 * Not a 1:1 walk by date. Two batches can want the same credit, a batch can
 * arrive split across two credits, and a quiet day can be followed by a
 * double one — so it is an assignment over the whole field, resolved by a
 * stable greedy pass: the strongest pair wins, every credit it claims is
 * consumed, and the next strongest gets its turn over what is left.
 *
 * Consuming the whole set rather than one credit is what keeps the result
 * coherent: a credit cannot both complete a split settlement and stand alone
 * as another batch's match.
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
      // A candidate that failed a gate is kept as a rejected alternative so the
      // report can say what was looked at, but it never enters the assignment.
      // Letting it compete is how a credit 95% off the batch ended up winning.
      if (disqualifiedBy(candidate.evidence, ruleSet.scoring)) continue;
      pairs.push({ batch, candidate, score });
    }
  }

  // Deterministic ordering: the same inputs must always produce the same
  // assignment, ties included, or the run is not reproducible.
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      compare(a.batch.id, b.batch.id) ||
      // Fewer credits first, so a clean single settlement beats a split that
      // happens to score the same. The brief's rule stays the priority.
      a.candidate.deposits.length - b.candidate.deposits.length ||
      compare(candidateKey(a.candidate), candidateKey(b.candidate)),
  );

  const takenBatches = new Set<BatchId>();
  const takenDeposits = new Set<string>();
  const winners = new Map<BatchId, Candidate>();

  for (const pair of pairs) {
    const claimed = depositIdsOf(pair.candidate);
    // A candidate with no deposits explains why nothing matched; it never
    // wins, so it cannot consume a batch that a real credit could still take.
    if (claimed.length === 0) continue;
    if (takenBatches.has(pair.batch.id)) continue;
    if (claimed.some((id) => takenDeposits.has(id))) continue;

    takenBatches.add(pair.batch.id);
    for (const id of claimed) takenDeposits.add(id);
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
    movementIds: depositIdsOf(candidate),
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
  return `${batchId}|${candidateKey(candidate)}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

