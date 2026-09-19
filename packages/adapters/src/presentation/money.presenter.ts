import { formatMoney } from './money-format.js';
import type { MoneyDto } from '@aa/contracts';
import type { Money } from '@aa/core';

/**
 * Money on the wire carries both the cents and their display form.
 *
 * The frontend could format the cents itself, but then two implementations
 * would decide what an amount looks like and the UI could drift from the
 * printed report. One formatter, one answer. See ADR-0008.
 */
export function toMoneyDto(money: Money): MoneyDto {
  return {
    cents: money.cents,
    currency: money.currency,
    formatted: formatMoney(money),
  };
}

export function toOptionalMoneyDto(money: Money | undefined): MoneyDto | undefined {
  return money ? toMoneyDto(money) : undefined;
}
