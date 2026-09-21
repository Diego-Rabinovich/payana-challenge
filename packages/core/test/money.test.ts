import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../src/domain/errors.js';
import { Money } from '../src/domain/money.js';

describe('Money — construction (F01-T01)', () => {
  it('rejects a non-integer number of cents', () => {
    expect(() => Money.ofCents(10.5)).toThrow(InvalidMoneyError);
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => Money.ofCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidMoneyError);
  });

  it('accepts negative amounts: a ledger records outflows', () => {
    expect(Money.ofCents(-1_386_800).cents).toBe(-1_386_800);
  });

  it('converts from major units when the caller already has a number', () => {
    expect(Money.ofMajorUnits(317_549).cents).toBe(31_754_900);
    expect(Money.ofMajorUnits(7_862.4).cents).toBe(786_240);
  });

  it('rejects a non-finite major-unit value', () => {
    expect(() => Money.ofMajorUnits(Number.NaN)).toThrow(InvalidMoneyError);
  });
});

describe('Money — arithmetic', () => {

  it('sums an empty list to zero rather than throwing', () => {
    expect(Money.sum([]).cents).toBe(0);
  });

});

describe('Money — rates, with the policy supplied by the caller (F01-T09)', () => {
  // Observed on a real Wompi transaction of $317,549.00:
  //   fee 7,862.40 · VAT 1,493.85 · withholding 4,763.23 · net 303,429.52
  // Wompi truncates. That is Wompi's policy, so its parser passes TRUNCATE;
  // Money itself has no opinion. See ADR-0008.
  const gross = Money.ofCents(31_754_900);
  const fee = Money.ofCents(786_240);

  it('truncates 19% VAT on the fee to 1,493.85 rather than 1,493.86', () => {
    // 786240 × 19 / 100 = 149385.6 exactly
    expect(fee.multipliedBy(19, 100, 'TRUNCATE').cents).toBe(149_385);
  });

  it('rounds the same figure up when the caller asks for HALF_UP', () => {
    expect(fee.multipliedBy(19, 100, 'HALF_UP').cents).toBe(149_386);
  });

  it('truncates 1.5% withholding on the gross to 4,763.23', () => {
    // 31754900 × 15 / 1000 = 476323.5 exactly
    expect(gross.multipliedBy(15, 1000, 'TRUNCATE').cents).toBe(476_323);
  });

  it('reproduces the observed net from the four parts', () => {
    const vat = fee.multipliedBy(19, 100, 'TRUNCATE');
    const withholding = gross.multipliedBy(15, 1000, 'TRUNCATE');

    expect(gross.minus(fee).minus(vat).minus(withholding).cents).toBe(30_342_952);
  });
});

describe('Money — allocation (F01-T01, F02-T16)', () => {
  it('distributes leftover cents and the parts sum back to the whole', () => {
    const parts = Money.ofCents(100).allocate([1, 1, 1]);

    expect(parts.map((p) => p.cents)).toEqual([34, 33, 33]);
    expect(Money.sum(parts).cents).toBe(100);
  });

  it('never loses or invents a cent, for a realistic settlement split', () => {
    const net = Money.ofCents(30_342_952);
    const grossPerPayment = [31_754_900, 33_269_000, 15_460_800, 24_369_800, 74_288_100];

    const parts = net.allocate(grossPerPayment);

    expect(parts).toHaveLength(grossPerPayment.length);
    expect(Money.sum(parts).cents).toBe(net.cents);
  });

  it('preserves the sign when allocating an outflow', () => {
    const parts = Money.ofCents(-100).allocate([1, 1, 1]);

    expect(parts.map((p) => p.cents)).toEqual([-34, -33, -33]);
    expect(Money.sum(parts).cents).toBe(-100);
  });
});

describe('Money — representation', () => {

  it('serialises as cents plus currency, never as a float', () => {
    expect(Money.ofCents(30_342_952).toJSON()).toEqual({ cents: 30_342_952, currency: 'COP' });
  });
});
