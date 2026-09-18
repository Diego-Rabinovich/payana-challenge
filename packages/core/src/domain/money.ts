import { InvalidMoneyError } from './errors.js';
import { type Rounding, allocateByLargestRemainder, scaleInteger } from './money-math.js';

export type Currency = 'COP';

/**
 * A signed amount of money, held as an integer number of minor units (COP
 * cents). The constructor is private so an invalid amount cannot exist.
 *
 * Money knows integers and nothing else. It deliberately does NOT know:
 *  - how a bank statement writes an amount   → adapters/shared/decimal-text
 *  - how to show one to a person             → adapters/presentation/money-format
 *  - which rounding a given gateway applies  → passed in by the caller
 *
 * Those are edges, not properties of an amount, and keeping them out is what
 * lets a new source or a new locale arrive without touching this file.
 * See ADR-0008.
 */
export class Money {
  private constructor(
    readonly cents: number,
    readonly currency: Currency,
  ) {}

  static ofCents(cents: number, currency: Currency = 'COP'): Money {
    if (!Number.isInteger(cents)) {
      throw new InvalidMoneyError('Money must be a whole number of cents', { cents });
    }
    if (!Number.isSafeInteger(cents)) {
      throw new InvalidMoneyError('Money exceeds the safe integer range', { cents });
    }
    return new Money(cents, currency);
  }

  /**
   * From a major-unit value, e.g. 317549.5 pesos. Rounds to the nearest cent
   * because the caller already went through a float. Prefer parsing text
   * straight to cents when the value comes from a document.
   */
  static ofMajorUnits(value: number, currency: Currency = 'COP'): Money {
    if (!Number.isFinite(value)) {
      throw new InvalidMoneyError('Money must be a finite number', { value });
    }
    return Money.ofCents(Math.round(value * 100), currency);
  }

  static zero(currency: Currency = 'COP'): Money {
    return new Money(0, currency);
  }

  static sum(amounts: readonly Money[], currency: Currency = 'COP'): Money {
    return amounts.reduce<Money>((total, amount) => total.plus(amount), Money.zero(currency));
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents + other.cents, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.ofCents(-this.cents, this.currency);
  }

  abs(): Money {
    return Money.ofCents(Math.abs(this.cents), this.currency);
  }

  /**
   * Applies a rate expressed as an exact fraction, e.g. 19% VAT as (19, 100).
   *
   * The rounding policy is the caller's: it describes what the *source system*
   * does, not what money is. Wompi truncates, so its parser passes 'TRUNCATE'.
   */
  multipliedBy(numerator: number, denominator: number, rounding: Rounding): Money {
    return Money.ofCents(scaleInteger(this.cents, numerator, denominator, rounding), this.currency);
  }

  /** Splits this amount proportionally; the parts always sum back to the whole. */
  allocate(weights: readonly number[]): Money[] {
    return allocateByLargestRemainder(this.cents, weights).map((cents) =>
      Money.ofCents(cents, this.currency),
    );
  }

  isZero(): boolean {
    return this.cents === 0;
  }

  isNegative(): boolean {
    return this.cents < 0;
  }

  isPositive(): boolean {
    return this.cents > 0;
  }

  compareTo(other: Money): number {
    this.assertSameCurrency(other);
    return this.cents === other.cents ? 0 : this.cents < other.cents ? -1 : 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  /** Unambiguous and locale-free, for logs and failure messages. */
  toString(): string {
    return `${this.currency} ${this.cents}`;
  }

  toJSON(): { cents: number; currency: Currency } {
    return { cents: this.cents, currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new InvalidMoneyError('Cannot operate across currencies', {
        left: this.currency,
        right: other.currency,
      });
    }
  }
}
