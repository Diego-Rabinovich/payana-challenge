import { InvalidMoneyError } from '@aa/core';
import { describe, expect, it } from 'vitest';
import {
  BANCOLOMBIA_STATEMENT,
  SPANISH_DECIMAL,
  parseAmount,
} from '../src/shared/decimal-text.js';

describe('parseAmount — Bancolombia statement rows', () => {
  it('parses the running balance of the January statement', () => {
    expect(parseAmount('393,279,689.19').cents).toBe(39_327_968_919);
  });



  it('never routes through a float', () => {
    // 7862.40 * 100 is 786239.99999999999 in floating point.
    expect(parseAmount('7,862.40', BANCOLOMBIA_STATEMENT).cents).toBe(786_240);
  });

  it('handles an amount with no decimals and one with a single decimal', () => {
    expect(parseAmount('1,000').cents).toBe(100_000);
    expect(parseAmount('1,000.5').cents).toBe(100_050);
  });

  it('tolerates a currency symbol, spaces and accountancy parentheses', () => {
    expect(parseAmount('$ 1,234.50').cents).toBe(123_450);
    expect(parseAmount('(1,234.50)').cents).toBe(-123_450);
    expect(parseAmount('1,234.50-').cents).toBe(-123_450);
  });
});

describe('parseAmount — other conventions', () => {
  it('parses the Spanish convention when told to', () => {
    expect(parseAmount('19.715.313,89', SPANISH_DECIMAL).cents).toBe(1_971_531_389);
  });

  it('reads the same digits differently depending on the format', () => {
    // The whole reason the format is a parameter: "1.23" is one peso and 23
    // cents under one convention, and one hundred and twenty-three under the
    // other. Guessing here would silently misstate a ledger by 100x.
    expect(parseAmount('1.23', BANCOLOMBIA_STATEMENT).cents).toBe(123);
    expect(parseAmount('1.23', SPANISH_DECIMAL).cents).toBe(12_300);
  });
});

describe('parseAmount — refuses what it cannot read', () => {
  it.each([
    ['a descriptor', 'PAGO DE PROV WOMPI'],
    ['too many decimals', '1,234.5678'],
    ['two decimal separators', '1.234.56'],
    ['an empty string', '   '],
  ])('throws on %s', (_case, text) => {
    expect(() => parseAmount(text)).toThrow(InvalidMoneyError);
  });
});
