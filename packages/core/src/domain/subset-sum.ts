/**
 * Bounded subset-sum over amounts in cents.
 *
 * The fallback, never the first move: it fires only when the daily-batch
 * hypothesis fails — a partial credit, a batch split across two transfers, a
 * payment that fell outside the cutoff. Arithmetic coincidence is weaker
 * evidence than structural correspondence, so a hit here never reaches
 * CONFIRMED, and several hits are reported as ambiguous rather than picked
 * between. See ADR-0004.
 *
 * The search is budgeted. Exceeding the budget is a reportable outcome
 * (`UNRESOLVED_COMBINATORIAL`), not a silently truncated answer: with a few
 * hundred payments a day, claiming to have searched exhaustively when we did
 * not would be the dishonest option.
 */

export interface SubsetSumOptions {
  readonly targetCents: number;
  readonly toleranceCents: number;
  readonly maxSubsetSize: number;
  readonly maxSolutions: number;
  readonly maxNodes: number;
}

export interface SubsetSumResult {
  /** Index sets into the original array, in the order they were found. */
  readonly solutions: readonly (readonly number[])[];
  /** True when the budget ran out before the search finished. */
  readonly budgetExceeded: boolean;
  readonly nodesVisited: number;
}

export function findSubsets(
  amounts: readonly number[],
  options: SubsetSumOptions,
): SubsetSumResult {
  const { targetCents, toleranceCents, maxSubsetSize, maxSolutions, maxNodes } = options;

  // Descending order makes the pruning bite early: the big amounts either fit
  // or are discarded near the root instead of deep in the tree.
  const ordered = amounts
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (b.value === a.value ? a.index - b.index : b.value - a.value));

  const values = ordered.map((entry) => entry.value);
  const reachable = suffixSums(values);

  const solutions: number[][] = [];
  const chosen: number[] = [];
  let nodesVisited = 0;
  let budgetExceeded = false;

  const search = (position: number, remaining: number): void => {
    if (budgetExceeded || solutions.length >= maxSolutions) return;
    if (++nodesVisited > maxNodes) {
      budgetExceeded = true;
      return;
    }
    if (chosen.length > 0 && Math.abs(remaining) <= toleranceCents) {
      solutions.push(chosen.map((slot) => ordered[slot]!.index).sort((a, b) => a - b));
      return;
    }
    if (position >= values.length) return;
    if (remaining < -toleranceCents) return; // overshot: amounts only add
    if (reachable[position]! < remaining - toleranceCents) return; // unreachable
    if (chosen.length >= maxSubsetSize) return;

    chosen.push(position);
    search(position + 1, remaining - values[position]!);
    chosen.pop();

    search(position + 1, remaining);
  };

  search(0, targetCents);

  return { solutions, budgetExceeded, nodesVisited };
}

function suffixSums(values: readonly number[]): number[] {
  const sums = new Array<number>(values.length + 1).fill(0);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    sums[index] = sums[index + 1]! + values[index]!;
  }
  return sums;
}
