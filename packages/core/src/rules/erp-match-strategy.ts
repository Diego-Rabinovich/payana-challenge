import type { AccountMap, JournalRef } from '../domain/account-map.js';
import type { BusinessCalendar } from '../domain/business-calendar.js';
import type { ErpEntry } from '../domain/erp-entry.js';
import type { ErpMatchLevel, LedgerGroup } from '../domain/erp-reconciliation.js';
import { type Evidence, evidence } from '../domain/evidence.js';
import { Money } from '../domain/money.js';
import type { ErpEntryIndex } from './erp-entry-index.js';

export interface ErpMatchContext {
  readonly index: ErpEntryIndex;
  readonly accountMap: AccountMap;
  readonly journal: JournalRef;
  readonly calendar: BusinessCalendar;
  /** How far a date may drift and still be the same money. */
  readonly dateShiftBusinessDays: number;
}

export interface ErpMatch {
  readonly entry: ErpEntry;
  readonly level: ErpMatchLevel;
  readonly evidence: Evidence;
}

/**
 * One rung of the cascade. Strategies only *find* an entry and say how they
 * found it; deciding whether the pair actually agrees is a separate concern
 * (see erp-assessment), so a new lookup rule never has to re-implement the
 * completeness and amount checks.
 */
export interface ErpMatchStrategy {
  readonly level: ErpMatchLevel;
  find(group: LedgerGroup, context: ErpMatchContext): ErpMatch | undefined;
}

/**
 * Level 1. The strongest evidence there is: the entry names the transaction.
 *
 * Handed to us by the data — Odoo entries in the Wompi journal carry the
 * gateway reference — which is why the cascade starts here rather than with
 * amounts.
 */
export class ReferenceMatchStrategy implements ErpMatchStrategy {
  readonly level = 'REF' as const;

  find(group: LedgerGroup, { index }: ErpMatchContext): ErpMatch | undefined {
    const entry = index.findByReference(group.key)[0];
    if (!entry) return undefined;

    return {
      entry,
      level: this.level,
      evidence: evidence('MATCHED_BY_REF', 'ERP', true, {
        expected: group.key,
        observed: entry.name,
      }),
    };
  }
}

/** Level 2. Same day, same amount on the journal's account. */
export class ExactMatchStrategy implements ErpMatchStrategy {
  readonly level = 'EXACT' as const;

  find(group: LedgerGroup, { index }: ErpMatchContext): ErpMatch | undefined {
    const amount = ledgerAmountOf(group);
    const entry = index.findByDateAndAmount(group.date.toString(), amount.cents)[0];
    if (!entry) return undefined;

    return {
      entry,
      level: this.level,
      evidence: evidence('MATCHED_EXACT', 'ERP', true, {
        expected: `${group.date.toString()} ${amount.toString()}`,
        observed: entry.name,
      }),
    };
  }
}

/**
 * Level 3. The day's movements sum to one entry.
 *
 * This is the rung that exists because granularities differ: without it, a
 * ledger of individual payments against a daily journal entry would report
 * every single line as missing.
 */
export class AggregatedMatchStrategy implements ErpMatchStrategy {
  readonly level = 'AGGREGATED' as const;

  find(group: LedgerGroup, { index }: ErpMatchContext): ErpMatch | undefined {
    const sameDay = index.findByDate(group.date.toString());
    if (sameDay.length !== 1) return undefined;

    const entry = sameDay[0]!;
    // Only aggregate when the entry is clearly larger than this group: an
    // equal amount would already have matched at level 2.
    const entryAmount = index.amountOf(entry);
    const groupAmount = ledgerAmountOf(group).cents;
    if (entryAmount === undefined || Math.abs(entryAmount) <= Math.abs(groupAmount)) {
      return undefined;
    }

    return {
      entry,
      level: this.level,
      evidence: evidence('MATCHED_AGGREGATED', 'ERP', true, {
        expected: `parte de ${entry.name}`,
        observed: ledgerAmountOf(group).toString(),
      }),
    };
  }
}

/**
 * Level 4. Same amount, a few business days off.
 *
 * Reported as a shift rather than as missing, because "recorded two days
 * late" and "never recorded" are different problems for whoever has to act.
 */
export class DateShiftMatchStrategy implements ErpMatchStrategy {
  readonly level = 'APPROXIMATE' as const;

  find(group: LedgerGroup, context: ErpMatchContext): ErpMatch | undefined {
    const { index, calendar, dateShiftBusinessDays } = context;
    const amount = ledgerAmountOf(group);

    const window: string[] = [];
    let cursor = group.date;
    for (let step = 0; step < dateShiftBusinessDays; step += 1) {
      cursor = calendar.nextBusinessDay(cursor);
      window.push(cursor.toString());
    }

    const entry = index.findByAmountWithin(window, amount.cents)[0];
    if (!entry) return undefined;

    return {
      entry,
      level: this.level,
      evidence: evidence('DATE_SHIFT', 'ERP', false, {
        expected: group.date.toString(),
        observed: entry.date.toString(),
      }),
    };
  }
}

/** The signed effect a group should have had on the journal's account. */
export function ledgerAmountOf(group: LedgerGroup): Money {
  return Money.sum(group.movements.map((movement) => movement.amount));
}

/** The cascade, in the order the brief's explanation depends on. */
export function defaultErpStrategies(): ErpMatchStrategy[] {
  return [
    new ReferenceMatchStrategy(),
    new ExactMatchStrategy(),
    new AggregatedMatchStrategy(),
    new DateShiftMatchStrategy(),
  ];
}
