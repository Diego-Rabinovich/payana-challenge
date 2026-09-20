import { Temporal } from '@js-temporal/polyfill';
import {
  type AccountMap,
  type DateRange,
  type ErpCorrection,
  type ErpEntry,
  type ErpEntryState,
  type ErpGateway,
  type ErpLine,
  type OwnEntry,
  Money,
} from '@aa/core';
import type { OdooClient } from './odoo-client.js';
import { entryBalances, toJournalEntry } from './journal-entry-builder.js';
import { REF_PREFIX, WriteRefused, assertCreatable, assertDeletable, policyFrom } from './write-guard.js';

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

/** Un borrador todavía no tiene número de secuencia, y decirlo sirve más que un hueco. */
const DRAFT_WITHOUT_NAME = '(borrador sin numerar)';

const MOVE_FIELDS = ['id', 'name', 'ref', 'date', 'state', 'journal_id'] as const;
const LINE_FIELDS = ['id', 'move_id', 'account_id', 'name', 'debit', 'credit'] as const;

export interface OdooErpGatewayOptions {
  /** When false, `createDraftEntry` refuses rather than writing. */
  readonly writeEnabled: boolean;
}

export class OdooErpGateway implements ErpGateway {
  /** Resolved once per process; a chart of accounts does not move. */
  private readonly accountIds = new Map<string, number>();

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

  /**
   * The entries this system left in a journal, by their reference prefix.
   *
   * Read-only and one round trip: the console asks so it can say "you already
   * created this one" after a reload. It asks Odoo rather than trusting a note
   * of our own, so an entry someone posted or deleted stops being reported as
   * a pending draft the moment they do it.
   */
  async listOwnEntries(journalId: number): Promise<readonly OwnEntry[]> {
    const moves = await this.client.searchRead<OdooMove>(
      'account.move',
      [
        ['journal_id', '=', journalId],
        ['ref', '=like', `${REF_PREFIX}%`],
      ],
      [...MOVE_FIELDS],
      { order: 'date asc, id asc' },
    );

    return moves.map((move) => ({
      ref: String(move.ref),
      id: String(move.id),
      name: move.name || DRAFT_WITHOUT_NAME,
      state: normaliseState(move.state),
      date: Temporal.PlainDate.from(move.date),
    }));
  }

  /**
   * Creates the correction as a draft, inside the books we were given.
   *
   * Every guard lives in `write-guard.ts` and runs before the request is
   * built, so a malformed correction cannot reach the wire at all. Draft,
   * never posted: a draft can be deleted, and this Odoo is somebody's
   * production.
   */
  async createDraftEntry(correction: ErpCorrection): Promise<string> {
    const policy = policyFrom(this.accountMap, this.options.writeEnabled);

    // Idempotency is the safety mechanism, not the flag: a rerun must find
    // its own earlier entry rather than create a second one.
    const existing = await this.findByRef(correction.ref);
    if (existing) return existing.id;

    const entry = toJournalEntry(correction, this.accountMap);
    assertCreatable(entry, policy);
    if (!entryBalances(entry)) {
      throw new WriteRefused(`El asiento de ${correction.ref} no cuadra`);
    }

    // Odoo wants numeric ids, not the codes a person reads. Resolving them
    // one by one against the allowlist means an account outside the chart
    // fails to resolve rather than being written to by accident.
    const lines = await Promise.all(
      entry.lines.map(async (line) => [
        0,
        0,
        {
          account_id: await this.accountIdFor(line.accountCode),
          name: line.label,
          debit: line.debit.cents / 100,
          credit: line.credit.cents / 100,
        },
      ]),
    );

    const id = await this.client.create('account.move', {
      journal_id: entry.journalId,
      date: entry.date,
      ref: entry.ref,
      move_type: 'entry',
      line_ids: lines,
    });
    return String(id);
  }

  /**
   * Removes an entry this system created, and only one it created.
   *
   * Narrower than creating: draft only, our reference only, our journals
   * only. If an accountant posted it or edited the reference, this refuses
   * and says why — at that point it is their entry, not ours.
   */
  async deleteDraftEntry(ref: string): Promise<boolean> {
    const policy = policyFrom(this.accountMap, this.options.writeEnabled);

    const entry = await this.findByRef(ref);
    if (!entry) return false;

    assertDeletable(entry, policy);
    await this.client.call('account.move', 'unlink', [[Number(entry.id)]]);
    return true;
  }

  /** Code to Odoo id, within the company context the client already carries. */
  private async accountIdFor(code: string): Promise<number> {
    const cached = this.accountIds.get(code);
    if (cached !== undefined) return cached;

    const found = await this.client.searchRead<{ id: number; code: string }>(
      'account.account',
      [['code', '=', code]],
      ['id', 'code'],
      { limit: 1 },
    );
    const id = found[0]?.id;
    if (id === undefined) {
      throw new WriteRefused(`La cuenta ${code} no existe en este Odoo`, { code });
    }

    this.accountIds.set(code, id);
    return id;
  }
}

function toEntry(move: OdooMove, lines: readonly ErpLine[]): ErpEntry {
  return {
    id: String(move.id),
    journalId: move.journal_id[0],
    name: move.name || DRAFT_WITHOUT_NAME,
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
  /**
   * Falso mientras el asiento está en borrador.
   *
   * Odoo no asigna número de secuencia hasta contabilizar, y devuelve `false`
   * en vez de una cadena. Declararlo `string` era una mentira que el
   * compilador no podía ver: el booleano viajó hasta la evidencia y tiró
   * abajo la pantalla del ERP con `text.replace is not a function`, apenas
   * creamos el primer borrador.
   */
  readonly name: string | false;
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
