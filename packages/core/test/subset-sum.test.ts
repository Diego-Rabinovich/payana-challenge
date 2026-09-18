import { describe, expect, it } from 'vitest';
import { findSubsets } from '../src/domain/subset-sum.js';

const options = {
  targetCents: 0,
  toleranceCents: 0,
  maxSubsetSize: 10,
  maxSolutions: 5,
  maxNodes: 100_000,
};

describe('findSubsets (F02-T11, F02-T12)', () => {
  it('finds the combination of payments that adds up to a credit', () => {
    const result = findSubsets([10_000, 20_000, 15_000, 7_000], {
      ...options,
      targetCents: 45_000,
    });

    expect(result.solutions).toContainEqual([0, 1, 2]);
    expect(result.budgetExceeded).toBe(false);
  });

  it('reports every combination when more than one fits', () => {
    // 30 = 10+20 and 30 = 30
    const result = findSubsets([30_000, 20_000, 10_000], { ...options, targetCents: 30_000 });

    expect(result.solutions.length).toBeGreaterThan(1);
  });

  it('accepts a near miss inside the tolerance', () => {
    const result = findSubsets([10_000, 20_050], {
      ...options,
      targetCents: 30_000,
      toleranceCents: 100,
    });

    expect(result.solutions).toContainEqual([0, 1]);
  });

  it('rejects a near miss outside the tolerance', () => {
    const result = findSubsets([10_000, 20_500], {
      ...options,
      targetCents: 30_000,
      toleranceCents: 100,
    });

    expect(result.solutions).toEqual([]);
  });

  it('never returns the empty set as a solution for a zero target', () => {
    const result = findSubsets([10_000], { ...options, targetCents: 0 });

    expect(result.solutions).toEqual([]);
  });

  it('honours the subset size cap', () => {
    const result = findSubsets([1_000, 1_000, 1_000, 1_000], {
      ...options,
      targetCents: 4_000,
      maxSubsetSize: 3,
    });

    expect(result.solutions).toEqual([]);
  });

  it('stops once it has enough solutions to call the result ambiguous', () => {
    const amounts = Array.from({ length: 12 }, () => 1_000);
    const result = findSubsets(amounts, {
      ...options,
      targetCents: 2_000,
      maxSolutions: 3,
    });

    expect(result.solutions).toHaveLength(3);
  });

  it('reports running out of budget instead of pretending the search finished', () => {
    // Hostile on purpose: forty distinct amounts and a target near the middle
    // of their range, so the search space is genuinely large.
    const amounts = Array.from({ length: 40 }, (_, index) => 1_000 + index * 7);
    const result = findSubsets(amounts, {
      ...options,
      targetCents: 22_730,
      maxSubsetSize: 40,
      maxSolutions: 1_000,
      maxNodes: 25,
    });

    expect(result.budgetExceeded).toBe(true);
    expect(result.nodesVisited).toBeGreaterThan(25);
  });

  it('prunes an unreachable target at the root instead of spending the budget', () => {
    // Everything available sums to far less than the target: the suffix-sum
    // check should settle that immediately rather than exploring.
    const result = findSubsets([1_000, 2_000, 3_000], {
      ...options,
      targetCents: 999_999_999,
    });

    expect(result.solutions).toEqual([]);
    expect(result.budgetExceeded).toBe(false);
    expect(result.nodesVisited).toBeLessThan(5);
  });

  it('handles an empty set of payments without throwing', () => {
    expect(findSubsets([], { ...options, targetCents: 1_000 }).solutions).toEqual([])
  });

  it('returns indices into the original array, not the sorted one', () => {
    const result = findSubsets([5_000, 100_000, 7_000], { ...options, targetCents: 107_000 });

    expect(result.solutions[0]).toEqual([1, 2]);
  });
});
