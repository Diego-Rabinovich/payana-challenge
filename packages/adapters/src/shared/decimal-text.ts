import { InvalidMoneyError, Money } from '@aa/core';
import type { Currency } from '@aa/core';

/**
 * Reading amounts out of source documents.
 *
 * This is an inbound adapter concern, not a domain one: each source writes
 * numbers its own way, and the domain should never learn a new one. Adding a
 * source with a different convention adds a constant here and touches nothing
 * else. See ADR-0008.
 */

export interface DecimalFormat {
  readonly thousands: string;
  readonly decimal: string;
}

/** Bancolombia statements: "393,279,689.19" and "-13,868.00". */
export const BANCOLOMBIA_STATEMENT: DecimalFormat = { thousands: ',', decimal: '.' };

/** Spanish-language convention: "393.279.689,19". */
export const SPANISH_DECIMAL: DecimalFormat = { thousands: '.', decimal: ',' };

/**
 * Parses a decimal string straight to cents, never building a float.
 *
 * `7862.40 * 100` is 786239.99999999999 in floating point; going through
 * strings is the only way to guarantee the cent is the one the document says.
 */
export function parseAmount(
  text: string,
  format: DecimalFormat = BANCOLOMBIA_STATEMENT,
  currency: Currency = 'COP',
): Money {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new InvalidMoneyError('Empty amount', { text });
  }

  const { body, negative } = extractSign(trimmed);
  const digitsOnly = stripSeparators(body, format.thousands);
  const [whole = '', fraction = '', ...rest] = splitOn(digitsOnly, format.decimal);

  if (rest.length > 0) {
    throw new InvalidMoneyError('Amount has more than one decimal separator', { text });
  }
  if (!/^\d+$/.test(whole) || (fraction !== '' && !/^\d+$/.test(fraction))) {
    throw new InvalidMoneyError('Amount contains non-numeric characters', { text });
  }
  if (fraction.length > 2) {
    throw new InvalidMoneyError('Amount has more than two decimals', { text });
  }

  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  const signed = negative ? -cents : cents;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new InvalidMoneyError('Amount exceeds the safe integer range', { text });
  }
  return Money.ofCents(Number(signed), currency);
}

/** Handles leading `-`, trailing `-`, a unicode minus, and accountancy parentheses. */
function extractSign(value: string): { body: string; negative: boolean } {
  let body = value;
  let negative = false;

  if (body.startsWith('(') && body.endsWith(')')) {
    negative = !negative;
    body = body.slice(1, -1).trim();
  }
  if (body.startsWith('-') || body.startsWith('−')) {
    negative = !negative;
    body = body.slice(1).trim();
  } else if (body.endsWith('-')) {
    negative = !negative;
    body = body.slice(0, -1).trim();
  }
  if (body.startsWith('+')) body = body.slice(1).trim();

  return { body: body.replace(/^\$/, '').replace(/\s/g, '').trim(), negative };
}

function stripSeparators(value: string, separator: string): string {
  return separator === '' ? value : value.split(separator).join('');
}

function splitOn(value: string, separator: string): string[] {
  return separator === '' ? [value] : value.split(separator);
}
