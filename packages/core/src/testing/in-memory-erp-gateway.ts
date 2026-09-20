import { Temporal } from '@js-temporal/polyfill';
import type { ErpEntry } from '../domain/erp-entry.js';
import { externalReferenceOf } from '../domain/erp-entry.js';
import type { AccountMap } from '../domain/account-map.js';
import type { ErpCorrection } from '../domain/erp-correction.js';
import type { ErpGateway, OwnEntry } from '../ports/erp-gateway.js';
import type { DateRange } from '../ports/source-connector.js';

/**
 * An ERP that lives in a list. Used by the domain tests and by the gateway
 * contract suite, so the Odoo adapter can be verified against exactly the same
 * expectations without anyone needing credentials.
 */
export class InMemoryErpGateway implements ErpGateway {
  private readonly entries: ErpEntry[];
  private sequence = 0;
  readonly created: ErpCorrection[] = [];
  readonly deleted: string[] = [];

  constructor(
    entries: readonly ErpEntry[] = [],
    /** Optional, only to give created lines real account codes. */
    private readonly accountMap?: AccountMap,
    private readonly journalId = 0,
  ) {
    this.entries = [...entries];
  }

  async readJournal(journalId: number, range: DateRange): Promise<ErpEntry[]> {
    return this.entries
      .filter((entry) => entry.journalId === journalId && withinRange(entry, range))
      .sort((a, b) => Temporal.PlainDate.compare(a.date, b.date) || compare(a.id, b.id));
  }

  async findByRef(ref: string): Promise<ErpEntry | undefined> {
    const wanted = ref.toUpperCase();
    return this.entries.find(
      (entry) => entry.ref?.toUpperCase() === wanted || externalReferenceOf(entry) === wanted,
    );
  }

  async createDraftEntry(correction: ErpCorrection): Promise<string> {
    const existing = await this.findByRef(correction.ref);
    // Idempotency is part of the contract, not an implementation detail: a
    // rerun must not produce a second entry for the same movement.
    if (existing) return existing.id;

    this.sequence += 1;
    const id = `mem-${this.sequence}`;
    this.entries.push({
      id,
      journalId: this.accountMap?.journal(correction.journalKey)?.id ?? this.journalId,
      name: `DRAFT/${id}`,
      ref: correction.ref,
      date: correction.date,
      state: 'draft',
      // Stored as the correction states it. This double is not an ERP, so it
      // does not invent a posting convention it would then have to defend.
      lines: correction.lines.map((line, index) => ({
        id: `${id}-${index}`,
        accountCode: this.accountMap?.accountFor(line.concept)?.code ?? line.concept,
        accountName: this.accountMap?.accountFor(line.concept)?.name ?? line.concept,
        amount: line.amount,
        label: line.label,
      })),
    });
    this.created.push(correction);
    return id;
  }

  async listOwnEntries(journalId: number): Promise<readonly OwnEntry[]> {
    return this.entries
      .filter((entry) => entry.journalId === journalId && entry.ref?.startsWith('mov:'))
      .map((entry) => ({
        ref: entry.ref!,
        id: entry.id,
        name: entry.name,
        state: entry.state,
        date: entry.date,
      }));
  }

  async deleteDraftEntry(ref: string): Promise<boolean> {
    const entry = await this.findByRef(ref);
    if (!entry) return false;
    // Same contract as the real one: a posted entry is nobody's to remove.
    if (entry.state !== 'draft') return false;

    const index = this.entries.findIndex((candidate) => candidate.id === entry.id);
    this.entries.splice(index, 1);
    this.deleted.push(ref);
    return true;
  }
}

function withinRange(entry: ErpEntry, range: DateRange): boolean {
  return (
    Temporal.PlainDate.compare(entry.date, range.from) >= 0 &&
    Temporal.PlainDate.compare(entry.date, range.to) <= 0
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
