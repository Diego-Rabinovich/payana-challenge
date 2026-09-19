import { Temporal } from '@js-temporal/polyfill';
import {
  type AccountMap,
  type DateRange,
  type ErpCorrection,
  type ErpEntry,
  type ErpEntryState,
  type ErpGateway,
  type ErpLine,
  Money,
} from '@aa/core';
import type { OdooClient } from './odoo-client.js';
import { entryBalances, toJournalEntry } from './journal-entry-builder.js';

/**
 * Odoo as an `ErpGateway`.
 *
 * Double entry lives here and nowhere else: the domain works in signed
 * single-entry movements, and translating between the two is exactly what an
 * adapter is for. See ADR-0006.
 *
 * Reading is unrestricted. Creating is deliberate — draft only, keyed on an
 * idempotency reference, and never touching an entry that already exists.
 */

const MOVE_FIELDS = ['id', 'name', 'ref', 'date', 'state', 'journal_id'] as const;
const LINE_FIELDS = ['id', 'move_id', 'account_id', 'name', 'debit', 'credit'] as const;

export interface OdooErpGatewayOptions {
  /** When false, `createDraftEntry` refuses rather than writing. */
  readonly writeEnabled: boolean;
}

export class OdooErpGateway implements ErpGateway {
  constructor(
    private readonly client: OdooClient,
    private readonly accountMap: AccountMap,
    private readonly options: OdooErpGatewayOptions = { writeEnabled: false },
  ) {}

  async readJournal(journalId: number, range: DateRange): Promise<ErpEntry[]> {
    const moves = await this.client.searchRead<OdooMove>(
      'account.move',
      [
        ['journal_id', '=', journalId],
        ['date', '>=', range.from.toString()],
        ['date', '<=', range.to.toString()],
      ],
      [...MOVE_FIELDS],
      { order: 'date asc, id asc' },
    );
    if (moves.length === 0) return [];

    // One call for every line of every move, rather than one call per move:
    // a journal with a few thousand entries would otherwise be a few thousand
    // round trips.
    const lines = await this.client.searchRead<OdooLine>(
      'account.move.line',
      [['move_id', 'in', moves.map((move) => move.id)]],
      [...LINE_FIELDS],
    );

    const byMove = new Map<number, ErpLine[]>();
    for (const line of lines) {
      const bucket = byMove.get(line.move_id[0]) ?? [];
      bucket.push(toLine(line));
      byMove.set(line.move_id[0], bucket);
    }

    return moves.map((move) => toEntry(move, byMove.get(move.id) ?? []));
  }

  async findByRef(ref: string): Promise<ErpEntry | undefined> {
    const moves = await this.client.searchRead<OdooMove>(
      'account.move',
      [['ref', '=ilike', ref]],
      [...MOVE_FIELDS],
      { limit: 1 },
    );
    const move = moves[0];
    if (!move) return undefined;

    const lines = await this.client.searchRead<OdooLine>(
      'account.move.line',
      [['move_id', '=', move.id]],
      [...LINE_FIELDS],
    );
    return toEntry(move, lines.map(toLine));
  }

  async createDraftEntry(correction: ErpCorrection): Promise<string> {
    if (!this.options.writeEnabled) {
      throw new Error(
        'Writing to Odoo is disabled. Set ODOO_WRITE_ENABLED=true and pass --confirm.',
      );
    }

    // Idempotency is the safety mechanism, not the flag: a rerun must find
    // its own earlier entry rather than create a second one.
    const existing = await this.findByRef(correction.ref);
    if (existing) return existing.id;

    const entry = toJournalEntry(correction, this.accountMap);
    if (!entryBalances(entry)) {
      // Odoo would reject it anyway; failing here says which correction was
      // malformed instead of surfacing an XML-RPC fault.
      throw new Error(`Refusing to post an unbalanced entry for ${correction.ref}`);
    }

    const id = await this.client.create('account.move', {
      journal_id: entry.journalId,
      date: entry.date,
      ref: entry.ref,
      move_type: 'entry',
      line_ids: entry.lines.map((line) => [
        0,
        0,
        {
          account_id: line.accountCode,
          name: line.label,
          debit: line.debit.cents / 100,
          credit: line.credit.cents / 100,
        },
      ]),
    });
    return String(id);
  }
}

function toEntry(move: OdooMove, lines: readonly ErpLine[]): ErpEntry {
  return {
    id: String(move.id),
    journalId: move.journal_id[0],
    name: move.name,
    ...(typeof move.ref === 'string' && move.ref ? { ref: move.ref } : {}),
    date: Temporal.PlainDate.from(move.date),
    state: normaliseState(move.state),
    lines,
  };
}

function toLine(line: OdooLine): ErpLine {
  // Odoo labels an account as "420500 Other sales"; the code is what the
  // chart of accounts keys on, so it is split out rather than matched on the
  // whole label.
  const [code = '', ...rest] = String(line.account_id[1]).split(' ');
  return {
    id: String(line.id),
    accountCode: code,
    accountName: rest.join(' '),
    // Collapsed on the way in: the ledger past this point is single entry.
    amount: Money.ofCents(Math.round(line.debit * 100) - Math.round(line.credit * 100)),
    ...(line.name ? { label: line.name } : {}),
  };
}

function normaliseState(state: string): ErpEntryState {
  return state === 'posted' || state === 'cancel' ? state : 'draft';
}

interface OdooMove {
  readonly id: number;
  readonly name: string;
  readonly ref: string | false;
  readonly date: string;
  readonly state: string;
  readonly journal_id: [number, string];
}

interface OdooLine {
  readonly id: number;
  readonly move_id: [number, string];
  readonly account_id: [number, string];
  readonly name: string | false;
  readonly debit: number;
  readonly credit: number;
}
