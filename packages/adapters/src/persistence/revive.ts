import { Money, type ErpReconciliationReport, type ReconciliationReport } from '@aa/core';
import { Temporal } from '@js-temporal/polyfill';

/**
 * Turning a stored report back into domain objects.
 *
 * A report is persisted with `JSON.stringify`, which is fine going out — but
 * coming back, `Money` is `{cents, currency}` and a `PlainDate` is a string.
 * The repository used to cast the result to `ReconciliationReport` and hand it
 * on, which typechecked and then failed at runtime the first time anything
 * called a method: the ERP screen died with
 * `correction.netToAccount.isZero is not a function`.
 *
 * Presenters survived only because they happen to read `.cents` and stringify
 * dates, so the hole stayed invisible until something did real arithmetic. A
 * cast is not a conversion; this is the conversion.
 */

/** Keys whose string value is an ISO date. Everything else stays a string. */
const DATE_KEYS = new Set([
  'batchDate',
  'valueDate',
  'date',
  'from',
  'to',
  'producedAt',
  'occurredAt',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function reviveFlowReport(stored: unknown): ReconciliationReport {
  return revive(stored) as ReconciliationReport;
}

export function reviveErpReport(stored: unknown): ErpReconciliationReport {
  return revive(stored) as ErpReconciliationReport;
}

/**
 * Walks the tree once, rebuilding the two value objects it can recognise.
 *
 * `Money` is identified by its own serialised shape rather than by a list of
 * field names: `toJSON` emits exactly `{cents, currency}`, so a field that
 * looks like that is one, and a new amount added to a report needs no edit
 * here. Dates cannot be detected that way — an ISO date is just a string — so
 * those go by key, which is why DATE_KEYS exists and Money has no equivalent.
 */
function revive(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => revive(item, key));

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isSerialisedMoney(record)) {
      return Money.ofCents(record['cents'] as number, record['currency'] as 'COP');
    }
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => [name, revive(item, name)]),
    );
  }

  if (typeof value === 'string' && key && DATE_KEYS.has(key) && ISO_DATE.test(value)) {
    return Temporal.PlainDate.from(value);
  }
  return value;
}

function isSerialisedMoney(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    typeof record['cents'] === 'number' &&
    typeof record['currency'] === 'string'
  );
}
