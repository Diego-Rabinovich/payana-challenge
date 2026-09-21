import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../src/domain/errors.js';
import { allocateByLargestRemainder, scaleInteger } from '../src/domain/money-math.js';

describe('scaleInteger', () => {

  it.each([
    ['TRUNCATE', 149_385],
    ['HALF_UP', 149_386],
    ['HALF_EVEN', 149_386],
  ] as const)('resolves a .6 remainder under %s', (rounding, expected) => {
    expect(scaleInteger(786_240, 19, 100, rounding)).toBe(expected);
  });

  it.each([
    ['TRUNCATE', 476_323],
    ['HALF_UP', 476_324],
    ['HALF_EVEN', 476_324],
  ] as const)('resolves an exact half under %s', (rounding, expected) => {
    // 31754900 × 15 / 1000 = 476323.5 — HALF_EVEN rounds to the even 476324.
    expect(scaleInteger(31_754_900, 15, 1000, rounding)).toBe(expected);
  });

  it('rounds an exact half down to the even neighbour under HALF_EVEN', () => {
    // 5 / 2 = 2.5 → 2 is even, so it stays.
    expect(scaleInteger(5, 1, 2, 'HALF_EVEN')).toBe(2);
    expect(scaleInteger(7, 1, 2, 'HALF_EVEN')).toBe(4);
  });

  it('truncates toward zero for negative values, never away from it', () => {
    expect(scaleInteger(-786_240, 19, 100, 'TRUNCATE')).toBe(-149_385);
    expect(scaleInteger(-786_240, 19, 100, 'HALF_UP')).toBe(-149_386);
  });

  it('survives products that overflow the safe integer range', () => {
    // 9e14 × 19 is far beyond Number.MAX_SAFE_INTEGER; BigInt keeps it exact.
    expect(scaleInteger(900_000_000_000_000, 19, 100, 'TRUNCATE')).toBe(171_000_000_000_000);
  });

  it('refuses a malformed rate instead of producing a number', () => {
    expect(() => scaleInteger(100, 1, 0, 'TRUNCATE')).toThrow(InvalidMoneyError);
    expect(() => scaleInteger(100, 1.5, 2, 'TRUNCATE')).toThrow(InvalidMoneyError);
  });
});

describe('allocateByLargestRemainder', () => {
  it('gives leftovers to the largest remainders, ties by position', () => {
    expect(allocateByLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });


  it('assigns nothing to a zero weight', () => {
    expect(allocateByLargestRemainder(100, [1, 0, 1])).toEqual([50, 0, 50]);
  });

  it('holds the sum invariant for every split it is given', () => {
    const cases: Array<[number, number[]]> = [
      [1, [1, 1, 1]],
      [7, [1, 2, 3]],
      [30_342_952, [31_754_900, 33_269_000, 15_460_800]],
      [-100, [7, 11, 13, 17]],
      [0, [1, 1]],
    ];

    for (const [total, weights] of cases) {
      const parts = allocateByLargestRemainder(total, weights);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
    }
  });

  it('refuses degenerate weights instead of guessing', () => {
    expect(() => allocateByLargestRemainder(100, [])).toThrow(InvalidMoneyError);
    expect(() => allocateByLargestRemainder(100, [0, 0])).toThrow(InvalidMoneyError);
    expect(() => allocateByLargestRemainder(100, [1, -1])).toThrow(InvalidMoneyError);
  });
});
