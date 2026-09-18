import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';

const date = (iso: string) => Temporal.PlainDate.from(iso);

// A slice of config/holidays-co.json, enough to exercise the real cases.
const calendar = new BusinessCalendar([
  '2026-01-01', // Año Nuevo
  '2026-01-12', // Reyes Magos, moved to Monday by Ley Emiliani
  '2026-04-02', // Jueves Santo
  '2026-04-03', // Viernes Santo
]);

describe('BusinessCalendar (F02-T01, F02-T02)', () => {
  it('settles 31 December on 2 January, because 1 January is a holiday', () => {
    // The case from the real statement: the first Wompi credit of the year is
    // Friday 2 Jan, nothing on the 1st. Without holidays this never matches.
    expect(calendar.nextBusinessDay(date('2025-12-31')).toString()).toBe('2026-01-02');
  });

  it('carries a Friday over the weekend to Monday', () => {
    expect(calendar.nextBusinessDay(date('2026-01-02')).toString()).toBe('2026-01-05');
  });

  it('skips a holiday that Ley Emiliani moved to a Monday', () => {
    // Friday 9 Jan → Monday 12 Jan is Reyes Magos → Tuesday 13 Jan.
    expect(calendar.nextBusinessDay(date('2026-01-09')).toString()).toBe('2026-01-13');
  });

  it('skips a run of consecutive holidays', () => {
    // Wednesday 1 Apr → Thu/Fri are Easter → Monday 6 Apr.
    expect(calendar.nextBusinessDay(date('2026-04-01')).toString()).toBe('2026-04-06');
  });

  it('counts several business days forward', () => {
    expect(calendar.nextBusinessDay(date('2025-12-31'), 2).toString()).toBe('2026-01-05');
    expect(calendar.nextBusinessDay(date('2025-12-31'), 3).toString()).toBe('2026-01-06');
  });

  it('recognises weekends and holidays as non-business days', () => {
    expect(calendar.isBusinessDay(date('2026-01-01'))).toBe(false); // holiday
    expect(calendar.isBusinessDay(date('2026-01-03'))).toBe(false); // Saturday
    expect(calendar.isBusinessDay(date('2026-01-04'))).toBe(false); // Sunday
    expect(calendar.isBusinessDay(date('2026-01-02'))).toBe(true);
  });

  it('measures the business-day gap a credit actually landed at', () => {
    expect(calendar.businessDaysBetween(date('2025-12-31'), date('2026-01-02'))).toBe(1);
    expect(calendar.businessDaysBetween(date('2025-12-31'), date('2026-01-05'))).toBe(2);
    expect(calendar.businessDaysBetween(date('2025-12-31'), date('2025-12-31'))).toBe(0);
  });

  it('reports a negative gap rather than pretending a date is in range', () => {
    expect(calendar.businessDaysBetween(date('2026-01-05'), date('2026-01-02'))).toBe(-1);
  });

  it('builds the settlement window a batch is expected to land in', () => {
    const window = calendar.settlementWindow(date('2025-12-31'), 1, 3);

    expect(window.from.toString()).toBe('2026-01-02');
    expect(window.to.toString()).toBe('2026-01-06');
  });

  it('refuses a nonsensical day count instead of looping', () => {
    expect(() => calendar.nextBusinessDay(date('2026-01-02'), 0)).toThrow(RangeError);
  });
});
