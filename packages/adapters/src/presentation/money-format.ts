import type { Money } from '@aa/core';

/**
 * Showing amounts to a person.
 *
 * An outbound adapter, symmetric with decimal-text on the way in: the domain
 * knows integers, and how those integers look to a reader is decided at the
 * edge. Keeping it here means a second locale is a case in a switch, not a
 * change to the value object.
 *
 * Written by hand rather than through Intl so golden-file tests do not shift
 * when the ICU data in the runtime changes.
 */

export type MoneyLocale = 'es-AR';

/** Formatted for the report and the UI: "$19.715.313,89", "-$13.868,00". */
export function formatMoney(money: Money, locale: MoneyLocale = 'es-AR'): string {
  const { symbol, thousands, decimal } = conventions(locale);

  const padded = Math.abs(money.cents).toString().padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  const fraction = padded.slice(-2);

  return `${money.cents < 0 ? '-' : ''}${symbol}${whole}${decimal}${fraction}`;
}

function conventions(locale: MoneyLocale) {
  switch (locale) {
    case 'es-AR':
      return { symbol: '$', thousands: '.', decimal: ',' };
  }
}
