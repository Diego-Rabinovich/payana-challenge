import { Temporal } from '@js-temporal/polyfill';

/**
 * Business-day arithmetic. The settlement window is expressed in business
 * days, so this decides which bank credits are even candidates for a batch.
 *
 * It matters more than it looks: in the January statement the first Wompi
 * credit is Friday 2 January, with nothing on the 1st or over the weekend.
 * The Wednesday 31 December sales credit on the 2nd because the 1st is a
 * holiday. Without holidays, that row never matches.
 *
 * Holiday dates are injected, not computed. Colombia moves several holidays
 * to the following Monday (Ley Emiliani), and a static, reviewable table is
 * deterministic and auditable where an algorithm would be a pile of edge
 * cases. The data lives in config/holidays-co.json. See ADR-0004.
 */
export class BusinessCalendar {
  private readonly holidays: ReadonlySet<string>;

  constructor(holidays: readonly string[]) {
    this.holidays = new Set(holidays);
  }

  isHoliday(date: Temporal.PlainDate): boolean {
    return this.holidays.has(date.toString());
  }

  isWeekend(date: Temporal.PlainDate): boolean {
    return date.dayOfWeek === 6 || date.dayOfWeek === 7;
  }

  isBusinessDay(date: Temporal.PlainDate): boolean {
    return !this.isWeekend(date) && !this.isHoliday(date);
  }

  /**
   * The nth business day strictly after `date`. `nextBusinessDay(d, 1)` is
   * T+1: the day a settlement is expected to land.
   */
  nextBusinessDay(date: Temporal.PlainDate, count = 1): Temporal.PlainDate {
    if (count < 1 || !Number.isInteger(count)) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }
    let cursor = date;
    let remaining = count;
    while (remaining > 0) {
      cursor = cursor.add({ days: 1 });
      if (this.isBusinessDay(cursor)) remaining -= 1;
    }
    return cursor;
  }

  /**
   * Business days from `from` (exclusive) to `to` (inclusive), or -1 when `to`
   * precedes `from`. Used to score how far a credit landed from T+1.
   */
  businessDaysBetween(from: Temporal.PlainDate, to: Temporal.PlainDate): number {
    if (Temporal.PlainDate.compare(to, from) < 0) return -1;
    let cursor = from;
    let days = 0;
    while (Temporal.PlainDate.compare(cursor, to) < 0) {
      cursor = cursor.add({ days: 1 });
      if (this.isBusinessDay(cursor)) days += 1;
    }
    return days;
  }

  /** The inclusive window a batch dated `date` is expected to settle within. */
  settlementWindow(
    date: Temporal.PlainDate,
    fromBusinessDays: number,
    toBusinessDays: number,
  ): { from: Temporal.PlainDate; to: Temporal.PlainDate } {
    return {
      from: this.nextBusinessDay(date, fromBusinessDays),
      to: this.nextBusinessDay(date, toBusinessDays),
    };
  }
}
