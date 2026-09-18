import { Temporal } from '@js-temporal/polyfill';

/**
 * Injected so tests are not at the mercy of the wall clock.
 *
 * The timezone is a constructor argument, not a constant in this file: which
 * timezone defines a business day is configuration (`TZ`), and the domain
 * should no more hardcode "America/Bogota" than it should hardcode a currency
 * symbol. See ADR-0008 for the same reasoning applied to money.
 */
export interface Clock {
  now(): Temporal.Instant;
  /** Today in the business timezone — which day a movement is filed under. */
  today(): Temporal.PlainDate;
}

export function createSystemClock(timeZone: string): Clock {
  return {
    now: () => Temporal.Now.instant(),
    today: () => Temporal.Now.plainDateISO(timeZone),
  };
}

export function fixedClock(instant: string, timeZone: string): Clock {
  const at = Temporal.Instant.from(instant);
  return {
    now: () => at,
    today: () => at.toZonedDateTimeISO(timeZone).toPlainDate(),
  };
}
