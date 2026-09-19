import type { ErpEntry } from '../domain/erp-entry.js';
import { externalReferenceOf, netOnAccount } from '../domain/erp-entry.js';

/**
 * Lookup structures over one journal's entries, built once per run.
 *
 * It also tracks what has already been claimed, so two ledger groups cannot
 * both match the same entry — and what stays unclaimed at the end is exactly
 * the set of entries with nothing behind them.
 */
export class ErpEntryIndex {
  private readonly byReference = new Map<string, ErpEntry[]>();
  private readonly byDate = new Map<string, ErpEntry[]>();
  private readonly consumed = new Set<string>();

  constructor(
    private readonly entries: readonly ErpEntry[],
    private readonly mainAccount: string,
  ) {
    for (const entry of entries) {
      const reference = externalReferenceOf(entry);
      if (reference) push(this.byReference, reference, entry);
      push(this.byDate, entry.date.toString(), entry);
    }
  }

  /** Case-insensitive: Odoo stores references uppercase, gateways lowercase. */
  findByReference(reference: string): ErpEntry[] {
    return this.available(this.byReference.get(reference.toUpperCase()) ?? []);
  }

  /** Entries already carrying a reference, whether or not they are claimed. */
  allWithReference(reference: string): ErpEntry[] {
    return this.byReference.get(reference.toUpperCase()) ?? [];
  }

  findByDate(date: string): ErpEntry[] {
    return this.available(this.byDate.get(date) ?? []);
  }

  findByDateAndAmount(date: string, cents: number): ErpEntry[] {
    return this.findByDate(date).filter((entry) => this.amountOf(entry) === cents);
  }

  findByAmountWithin(dates: readonly string[], cents: number): ErpEntry[] {
    return dates.flatMap((date) => this.findByDateAndAmount(date, cents));
  }

  /** Signed effect on the journal's own account, which is what we compare. */
  amountOf(entry: ErpEntry): number | undefined {
    return netOnAccount(entry, this.mainAccount)?.cents;
  }

  claim(entry: ErpEntry): void {
    this.consumed.add(entry.id);
  }

  isClaimed(entry: ErpEntry): boolean {
    return this.consumed.has(entry.id);
  }

  /** Entries no ledger group accounted for. */
  unclaimed(): ErpEntry[] {
    return this.entries.filter((entry) => !this.consumed.has(entry.id));
  }

  get size(): number {
    return this.entries.length;
  }

  private available(entries: readonly ErpEntry[]): ErpEntry[] {
    return entries.filter((entry) => !this.consumed.has(entry.id));
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}
