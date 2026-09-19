import type { Temporal } from '@js-temporal/polyfill';
import { ConfigurationError } from './errors.js';

/**
 * When a channel closes a batch, and when the money is then expected.
 *
 * Two separate questions that used to be one hardcoded answer:
 *
 *   cadence  — how often the channel cuts. Wompi cuts every day; a channel
 *              that pays out every Monday cuts weekly, and its batch is a
 *              week of charges rather than a day of them.
 *   window   — how long after the cut the credit takes, in business days.
 *              `from` is the expected day (T+1 for Wompi, which is what the
 *              brief states) and `to` is how late it may land before the
 *              match stops being believable.
 *
 * Both are per channel and both are data. Adding a source that batches
 * weekly is a JSON entry plus a parser: no rule, no use case and no domain
 * type has to change. That is the test this type exists to pass.
 */

export type SettlementCadence = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface SettlementWindow {
  /** Business days after the cut when the credit is expected. */
  readonly fromBusinessDays: number;
  /** The last business day it may arrive on and still be considered. */
  readonly toBusinessDays: number;
}

export interface SettlementPolicy {
  readonly cadence: SettlementCadence;
  /**
   * WEEKLY only: the ISO weekday a batch closes on, 1 Monday to 7 Sunday.
   * A channel paying out on Mondays closes on Sunday, so this is 7.
   */
  readonly weekEndsOn?: number;
  /** MONTHLY only: day of month the batch closes on. 31 means month end. */
  readonly monthEndsOn?: number;
  readonly window: SettlementWindow;
}

export const DAILY_T1: SettlementPolicy = {
  cadence: 'DAILY',
  window: { fromBusinessDays: 1, toBusinessDays: 3 },
};

export function assertPolicy(policy: SettlementPolicy, channel: string): SettlementPolicy {
  const { fromBusinessDays, toBusinessDays } = policy.window;
  if (fromBusinessDays < 1 || toBusinessDays < fromBusinessDays) {
    throw new ConfigurationError(`Settlement window for ${channel} is empty or inverted`, {
      channel,
      fromBusinessDays,
      toBusinessDays,
    });
  }
  if (policy.cadence === 'WEEKLY' && !isWeekday(policy.weekEndsOn)) {
    throw new ConfigurationError(`Weekly channel ${channel} does not say which day it closes on`, {
      channel,
      weekEndsOn: policy.weekEndsOn,
    });
  }
  if (policy.cadence === 'MONTHLY' && !isMonthDay(policy.monthEndsOn)) {
    throw new ConfigurationError(`Monthly channel ${channel} does not say which day it closes on`, {
      channel,
      monthEndsOn: policy.monthEndsOn,
    });
  }
  return policy;
}

/**
 * The date whose batch a charge belongs to: the first cut on or after it.
 *
 * Under DAILY this is the charge's own date, which is why the daily case
 * needed no such notion before. Under WEEKLY a Tuesday charge and a Thursday
 * charge both close on the same Sunday and land in one batch — and the
 * settlement window is counted from that Sunday, not from either charge.
 */
export function closingDateFor(
  date: Temporal.PlainDate,
  policy: SettlementPolicy,
): Temporal.PlainDate {
  switch (policy.cadence) {
    case 'DAILY':
      return date;

    case 'WEEKLY': {
      const target = policy.weekEndsOn!;
      const ahead = (target - date.dayOfWeek + 7) % 7;
      return date.add({ days: ahead });
    }

    case 'MONTHLY': {
      const target = Math.min(policy.monthEndsOn!, date.daysInMonth);
      return date.day <= target
        ? date.with({ day: target })
        : nextMonthClose(date, policy.monthEndsOn!);
    }
  }
}

function nextMonthClose(date: Temporal.PlainDate, monthEndsOn: number): Temporal.PlainDate {
  const next = date.add({ months: 1 }).with({ day: 1 });
  return next.with({ day: Math.min(monthEndsOn, next.daysInMonth) });
}

/** How the cadence reads in a report, so the UI never spells it out itself. */
export function describeCadence(policy: SettlementPolicy): string {
  switch (policy.cadence) {
    case 'DAILY':
      return 'corte diario';
    case 'WEEKLY':
      return `corte semanal (cierra ${WEEKDAYS[policy.weekEndsOn! - 1]})`;
    case 'MONTHLY':
      return `corte mensual (cierra el día ${policy.monthEndsOn})`;
  }
}

const WEEKDAYS = [
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
  'domingo',
] as const;

function isWeekday(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

function isMonthDay(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;
}
