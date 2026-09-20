import type { ErpEntry } from '../domain/erp-entry.js';
import type { LedgerGroup } from '../domain/erp-reconciliation.js';
import { evidence } from '../domain/evidence.js';
import { Money } from '../domain/money.js';
import type { ErpEntryIndex } from './erp-entry-index.js';
import { type ErpMatch, type ErpMatchContext, ledgerAmountOf } from './erp-match-strategy.js';

/**
 * Which ledger group goes with which journal entry.
 *
 * This used to be a cascade run once per group: the first group to reach an
 * entry claimed it and the rest found it gone. On 20 January the bank had
 * three movements and Odoo one entry of $540.836,41. The interest credit of
 * $2.530,65 got there first, matched as "part of" the entry because it was
 * merely smaller than it, and the real Wompi credit — identical to the cent —
 * was then reported as missing from the ERP. Two wrong findings out of one
 * correct fact, decided by hash order.
 *
 * So the comparison is made over the whole day at once, in passes, strongest
 * evidence first. Nothing is claimed until every group on that date has had
 * the chance to claim it:
 *
 *   1. by reference     the entry names the transaction. Unambiguous.
 *   2. by exact amount   same day, same figure. All pairs at once.
 *   3. aggregated        several groups that together *sum* to one entry.
 *   4. nearest            what is left, paired by smallest difference and
 *                         reported as a mismatch.
 *   5. date shift         the same figure a few business days away.
 *
 * Each pass is greedy over pairs it has already scored, so the result does not
 * depend on the order groups arrive in — which is what went wrong before.
 */

export type ErpAssignment = ReadonlyMap<string, ErpMatch>;

export function assignErpMatches(
  groups: readonly LedgerGroup[],
  context: ErpMatchContext,
): ErpAssignment {
  const { index } = context;
  const matches = new Map<string, ErpMatch>();
  const pending = new Set(groups.map((group) => group.key));
  const byKey = new Map(groups.map((group) => [group.key, group]));

  const take = (group: LedgerGroup, match: ErpMatch): void => {
    index.claim(match.entry);
    matches.set(group.key, match);
    pending.delete(group.key);
  };

  // ── 1. Reference. The data hands us this one; nothing competes with it.
  for (const group of groups) {
    const entry = index.findByReference(group.key)[0];
    if (!entry) continue;

    take(group, {
      entry,
      level: 'REF',
      evidence: evidence('MATCHED_BY_REF', 'ERP', true, {
        expected: group.key,
        observed: entry.name,
      }),
    });
  }

  // ── 2 to 4. Everything else is decided one date at a time.
  for (const date of datesOf(groups, pending, byKey)) {
    const here = () =>
      [...pending].map((key) => byKey.get(key)!).filter((g) => g.date.toString() === date);

    matchExact(here(), date, index, take);
    matchAggregated(here(), date, index, take);
    matchNearest(here(), date, index, take);
  }

  // ── 5. Same figure, a few business days off. Late is not the same as absent.
  for (const key of [...pending]) {
    const group = byKey.get(key)!;
    const amount = ledgerAmountOf(group);
    const window: string[] = [];
    let cursor = group.date;
    for (let step = 0; step < context.dateShiftBusinessDays; step += 1) {
      cursor = context.calendar.nextBusinessDay(cursor);
      window.push(cursor.toString());
    }

    const entry = index.findByAmountWithin(window, amount.cents)[0];
    if (!entry) continue;

    take(group, {
      entry,
      level: 'APPROXIMATE',
      evidence: evidence('DATE_SHIFT', 'ERP', false, {
        expected: group.date.toString(),
        observed: entry.date.toString(),
      }),
    });
  }

  return matches;
}

/** Same day, same figure. Every pair is found before any is taken. */
function matchExact(
  groups: readonly LedgerGroup[],
  date: string,
  index: ErpEntryIndex,
  take: (group: LedgerGroup, match: ErpMatch) => void,
): void {
  const entries = index.findByDate(date);

  const pairs = groups.flatMap((group) =>
    entries
      .filter((entry) => index.amountOf(entry) === ledgerAmountOf(group).cents)
      .map((entry) => ({ group, entry })),
  );

  const usedGroups = new Set<string>();
  const usedEntries = new Set<string>();
  for (const { group, entry } of pairs) {
    if (usedGroups.has(group.key) || usedEntries.has(entry.id)) continue;
    usedGroups.add(group.key);
    usedEntries.add(entry.id);

    take(group, {
      entry,
      level: 'EXACT',
      evidence: evidence('MATCHED_EXACT', 'ERP', true, {
        expected: `${date} ${ledgerAmountOf(group).toString()}`,
        observed: entry.name,
      }),
    });
  }
}

/**
 * Several groups that together are one entry.
 *
 * The sum has to be the entry, which is the check the old version lacked: it
 * accepted any single group merely *smaller* than the entry, so one small
 * movement could swallow an entry that belonged to another. An aggregation
 * that does not add up is not an aggregation.
 */
function matchAggregated(
  groups: readonly LedgerGroup[],
  date: string,
  index: ErpEntryIndex,
  take: (group: LedgerGroup, match: ErpMatch) => void,
): void {
  if (groups.length < 2) return;

  const total = Money.sum(groups.map(ledgerAmountOf)).cents;
  const entry = index.findByDate(date).find((candidate) => index.amountOf(candidate) === total);
  if (!entry) return;

  for (const group of groups) {
    take(group, {
      entry,
      level: 'AGGREGATED',
      evidence: evidence('MATCHED_AGGREGATED', 'ERP', true, {
        expected: `parte de ${entry.name}`,
        observed: `${ledgerAmountOf(group).toString()} de ${Money.ofCents(total).toString()}`,
      }),
    });
  }
}

/**
 * What is left on the date, paired by smallest difference.
 *
 * Only when the entry is closer to the group than nothing is — that is, when
 * the gap is smaller than the group itself. Pairing $50.490.767 with an entry
 * of $540.836 would not be a mismatch to investigate, it would be noise, and
 * reporting both as absent is the truer answer.
 */
function matchNearest(
  groups: readonly LedgerGroup[],
  date: string,
  index: ErpEntryIndex,
  take: (group: LedgerGroup, match: ErpMatch) => void,
): void {
  const entries = index.findByDate(date);
  if (entries.length === 0) return;

  const pairs = groups
    .flatMap((group) =>
      entries.flatMap((entry) => {
        const erp = index.amountOf(entry);
        if (erp === undefined) return [];
        const ledger = ledgerAmountOf(group).cents;
        const gap = Math.abs(erp - ledger);
        return gap < Math.abs(ledger) ? [{ group, entry, gap }] : [];
      }),
    )
    .sort((a, b) => a.gap - b.gap || compare(a.group.key, b.group.key));

  const usedGroups = new Set<string>();
  const usedEntries = new Set<string>();
  for (const { group, entry } of pairs) {
    if (usedGroups.has(group.key) || usedEntries.has(entry.id)) continue;
    usedGroups.add(group.key);
    usedEntries.add(entry.id);

    take(group, {
      entry,
      level: 'APPROXIMATE',
      evidence: evidence('MATCHED_EXACT', 'ERP', false, {
        expected: `${date} ${ledgerAmountOf(group).toString()}`,
        observed: `${entry.name} ${Money.ofCents(index.amountOf(entry) ?? 0).toString()}`,
        detail: 'el asiento más cercano de esa fecha, sin coincidir',
      }),
    });
  }
}

/** Dates that still have something to resolve, in order. */
function datesOf(
  groups: readonly LedgerGroup[],
  pending: ReadonlySet<string>,
  byKey: ReadonlyMap<string, LedgerGroup>,
): string[] {
  const dates = new Set<string>();
  for (const key of pending) {
    const group = byKey.get(key);
    if (group) dates.add(group.date.toString());
  }
  void groups;
  return [...dates].sort();
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
