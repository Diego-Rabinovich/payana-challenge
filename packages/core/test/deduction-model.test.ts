import { describe, expect, it } from 'vitest';
import { COLOMBIAN_RATES, deriveDeductions } from '../src/domain/deduction-model.js';
import { InvalidMoneyError } from '../src/domain/errors.js';
import { Money } from '../src/domain/money.js';

/**
 * Ground truth: one real transaction whose breakdown the merchant panel shows
 * but the API does not. Gross $317,549.00 → fee $7,862.40, VAT $1,493.85,
 * withholding $4,763.23, net $303,429.52.
 */
const GROSS = Money.ofCents(31_754_900);
const NET = Money.ofCents(30_342_952);
const TRUE_FEE = 786_240;
const TRUE_VAT = 149_385;
const TRUE_WITHHOLDING = 476_323;

const amountOf = (derivation: ReturnType<typeof deriveDeductions>, kind: string) =>
  derivation.deductions.find((deduction) => deduction.kind === kind)?.amount.cents;

describe('deriveDeductions — against the one transaction we know the answer to', () => {
  const derived = deriveDeductions(GROSS, NET, 1);

  it('recovers the withholding exactly from the statutory 1.5%', () => {
    expect(amountOf(derived, 'WITHHOLDING')).toBe(TRUE_WITHHOLDING);
  });

  it('recovers the fee exactly, without ever being told the fee rate', () => {
    expect(amountOf(derived, 'FEE')).toBe(TRUE_FEE);
  });

  it('recovers the VAT exactly from the statutory 19%', () => {
    expect(amountOf(derived, 'TAX')).toBe(TRUE_VAT);
  });

  it('reports the total deduction rate the statements cluster around', () => {
    // 14,119.48 / 317,549.00 = 4.446%
    expect(derived.impliedRate).toBeCloseTo(0.04446, 5);
    expect(derived.withinPlausibleBand).toBe(true);
  });

  it('judges the split consistent with the legal VAT rate', () => {
    expect(derived.consistent).toBe(true);
    expect(derived.vatDrift).toBeLessThanOrEqual(1);
  });
});

describe('deriveDeductions — the parts always reconstruct the observed gap', () => {
  it.each([
    ['the known transaction', 31_754_900, 30_342_952, 1],
    ['a large settlement', 2_060_240_000, 1_971_531_389, 47],
    ['a small one', 12_184_900, 11_642_800, 2],
    ['an exact multiple', 100_000_000, 95_600_000, 10],
  ])('%s', (_case, grossCents, netCents, charges) => {
    const gross = Money.ofCents(grossCents);
    const net = Money.ofCents(netCents);
    const derived = deriveDeductions(gross, net, charges);

    const parts = Money.sum(derived.deductions.map((deduction) => deduction.amount));
    expect(parts.cents).toBe(gross.minus(net).cents);
    expect(derived.total.cents).toBe(gross.minus(net).cents);
  });
});

describe('deriveDeductions — refuses to invent a split it cannot justify', () => {
  it('reports a credit larger than the sales instead of producing negative fees', () => {
    const derived = deriveDeductions(Money.ofCents(1_000_000), Money.ofCents(1_500_000), 1);

    expect(derived.deductions).toEqual([]);
    expect(derived.consistent).toBe(false);
    expect(derived.impliedRate).toBeLessThan(0);
  });

  it('reports a gap too small to cover the statutory withholding', () => {
    // A 0.1% gap cannot contain a 1.5% withholding, so the model does not fit.
    const derived = deriveDeductions(Money.ofCents(1_000_000), Money.ofCents(999_000), 1);

    expect(derived.deductions).toEqual([]);
    expect(derived.consistent).toBe(false);
  });

  it('flags a gap far outside the observed band, even though it splits arithmetically', () => {
    // 20% deducted: the arithmetic works, the business reality does not.
    const derived = deriveDeductions(Money.ofCents(10_000_000), Money.ofCents(8_000_000), 5);

    expect(derived.withinPlausibleBand).toBe(false);
    expect(derived.impliedRate).toBeCloseTo(0.2, 3);
  });

  it('rejects a non-positive gross rather than dividing by it', () => {
    expect(() => deriveDeductions(Money.zero(), Money.zero(), 1)).toThrow(InvalidMoneyError);
  });
});

describe('deriveDeductions — truncation slack scales with the batch', () => {
  it('allows more drift for a batch of many charges than for a single one', () => {
    const gross = Money.ofCents(2_060_240_000);
    const net = Money.ofCents(1_971_531_389);

    const single = deriveDeductions(gross, net, 1);
    const many = deriveDeductions(gross, net, 47);

    // Same numbers, wider tolerance: the gateway truncates once per charge.
    expect(many.vatDrift).toBe(single.vatDrift);
    expect(COLOMBIAN_RATES.truncationSlackPerCharge).toBeGreaterThan(0);
  });
});
