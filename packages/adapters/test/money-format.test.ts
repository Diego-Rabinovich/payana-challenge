import { Money } from '@aa/core';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '../src/presentation/money-format.js';
import { SPANISH_DECIMAL, parseAmount } from '../src/shared/decimal-text.js';

describe('formatMoney (es-AR)', () => {
  it('groups thousands with dots and separates decimals with a comma', () => {
    expect(formatMoney(Money.ofCents(1_971_531_389))).toBe('$19.715.313,89');
  });

  it('keeps the leading zero on amounts below one peso', () => {
    expect(formatMoney(Money.ofCents(5))).toBe('$0,05');
    expect(formatMoney(Money.ofCents(0))).toBe('$0,00');
  });

  it('puts the sign before the symbol for outflows', () => {
    expect(formatMoney(Money.ofCents(-1_386_800))).toBe('-$13.868,00');
  });

  it('round-trips against the parser', () => {
    const original = Money.ofCents(39_327_968_919);
    const text = formatMoney(original).replace('$', '');

    expect(parseAmount(text, SPANISH_DECIMAL).cents).toBe(original.cents);
  });
});
