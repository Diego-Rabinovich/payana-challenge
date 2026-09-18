import { InvalidMoneyError } from './errors.js';

/**
 * Integer arithmetic on minor units. Pure functions over `number`, with no
 * knowledge of Money, currencies or text.
 *
 * They exist separately because they are *algorithms*, not properties of an
 * amount: they are worth testing on their own, and keeping them here stops
 * Money from growing a body of arithmetic that has nothing to do with being
 * a value object.
 *
 * Everything goes through BigInt internally. `cents × rate` overflows the
 * safe integer range for realistic COP amounts, and a silent precision loss
 * here would surface as a one-cent reconciliation failure much later.
 */

/**
 * How to resolve a fraction of a minor unit.
 *
 * The policy is a parameter rather than a constant because it belongs to
 * whoever computed the number, not to money itself. Wompi truncates; another
 * gateway may not. See ADR-0008.
 */
export type Rounding = 'TRUNCATE' | 'HALF_UP' | 'HALF_EVEN';

/** Computes `value × numerator / denominator` under an explicit rounding policy. */
export function scaleInteger(
  value: number,
  numerator: number,
  denominator: number,
  rounding: Rounding,
): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new InvalidMoneyError('A rate must be an integer fraction', { numerator, denominator });
  }
  if (denominator === 0) {
    throw new InvalidMoneyError('A rate cannot have a zero denominator', { numerator, denominator });
  }

  const negative = value < 0 !== numerator < 0 !== denominator < 0;
  const product = BigInt(Math.abs(value)) * BigInt(Math.abs(numerator));
  const divisor = BigInt(Math.abs(denominator));

  const quotient = product / divisor;
  const remainder = product % divisor;
  const magnitude = remainder === 0n ? quotient : applyRounding(quotient, remainder, divisor, rounding);

  return toSafeInteger(negative ? -magnitude : magnitude);
}

function applyRounding(quotient: bigint, remainder: bigint, divisor: bigint, rounding: Rounding): bigint {
  const twiceRemainder = remainder * 2n;
  switch (rounding) {
    case 'TRUNCATE':
      return quotient;
    case 'HALF_UP':
      return twiceRemainder >= divisor ? quotient + 1n : quotient;
    case 'HALF_EVEN':
      if (twiceRemainder > divisor) return quotient + 1n;
      if (twiceRemainder < divisor) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + 1n;
  }
}

/**
 * Splits `total` proportionally to `weights`, giving leftover units to the
 * largest fractional remainders and breaking ties by position.
 *
 * The guarantee that matters: the parts always sum back to the total. Without
 * it, attributing a settlement's net to individual payments would lose or
 * invent cents, and a report that does that cannot be trusted anywhere else.
 */
export function allocateByLargestRemainder(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) {
    throw new InvalidMoneyError('Cannot allocate across zero weights', {});
  }
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new InvalidMoneyError('Weights must be non-negative integers', { weights });
  }
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  if (weightTotal === 0) {
    throw new InvalidMoneyError('Weights must not sum to zero', { weights });
  }

  const negative = total < 0;
  const magnitude = BigInt(Math.abs(total));
  const divisor = BigInt(weightTotal);

  const shares = weights.map((weight, index) => {
    const product = magnitude * BigInt(weight);
    return { index, units: product / divisor, remainder: product % divisor };
  });

  let distributed = shares.reduce((sum, share) => sum + share.units, 0n);
  const byRemainderDesc = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of byRemainderDesc) {
    if (distributed >= magnitude) break;
    share.units += 1n;
    distributed += 1n;
  }

  return shares.map((share) => toSafeInteger(negative ? -share.units : share.units));
}

function toSafeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new InvalidMoneyError('Result exceeds the safe integer range', { value: value.toString() });
  }
  return Number(value);
}
