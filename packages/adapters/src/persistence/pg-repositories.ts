import { Temporal } from '@js-temporal/polyfill';
import {
  type AccountId,
  type DateRange,
  Money,
  type Movement,
  type MovementId,
  type MovementRepository,
  type MovementType,
  type RawRecord,
  type RawRecordId,
  type RawRecordRepository,
  type RunId,
  type RunRepository,
  type SourceId,
  accountId,
  movementId,
  rawRecordId,
  runId,
  sourceId,
} from '@aa/core';
import type { PgClient } from './pg-client.js';

/**
 * Postgres behind the repository ports.
 *
 * Every write is an upsert keyed on the content-derived id, so re-running an
 * ingestion converges instead of duplicating — the idempotency the contract
 * suite checks is enforced here by the primary key, not by a prior read.
 */

export class PgRawRecordRepository implements RawRecordRepository {
  constructor(private readonly db: PgClient) {}

  async upsert(record: RawRecord): Promise<void> {
    await this.db.query(
      `insert into raw_records (id, source_id, origin, fetched_at, content_hash, payload, run_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set run_id = excluded.run_id`,
      [
        record.id,
        record.sourceId,
        record.origin,
        record.fetchedAt.toString(),
        record.contentHash,
        Buffer.from(typeof record.payload === 'string' ? record.payload : record.payload),
        record.runId ?? null,
      ],
    );
  }

  async findById(id: RawRecordId): Promise<RawRecord | undefined> {
    const { rows } = await this.db.query<RawRow>('select * from raw_records where id = $1', [id]);
    return rows[0] ? toRawRecord(rows[0]) : undefined;
  }

  async findBySource(source: SourceId): Promise<RawRecord[]> {
    const { rows } = await this.db.query<RawRow>(
      'select * from raw_records where source_id = $1 order by fetched_at desc',
      [source],
    );
    return rows.map(toRawRecord);
  }
}

export class PgMovementRepository implements MovementRepository {
  constructor(private readonly db: PgClient) {}

  /**
   * Idempotente por el id, que es un hash del contenido.
   *
   * `run_id` se conserva en vez de pisarse: dice qué corrida trajo el
   * movimiento al ledger, y eso no cambia porque una corrida posterior lo
   * vuelva a ver. Con `excluded.run_id` significaba «la última que pasó por
   * acá», que además hacía que borrar esa corrida dejara sin procedencia a
   * movimientos que había traído otra.
   */
  async upsertMany(movements: readonly Movement[]): Promise<{ inserted: number; updated: number }> {
    if (movements.length === 0) return { inserted: 0, updated: 0 };

    return this.db.transaction(async (client) => {
      let inserted = 0;
      for (const movement of movements) {
        const result = await client.query(
          `insert into movements (
             id, account_id, external_id, occurred_at, value_date, type, amount_cents,
             currency, counterparty, description, source_id, raw_record_id, locator,
             metadata, run_id
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           on conflict (id) do update set run_id = coalesce(movements.run_id, excluded.run_id)`,
          [
            movement.id,
            movement.accountId,
            movement.externalId ?? null,
            movement.occurredAt.toString(),
            movement.valueDate.toString(),
            movement.type,
            movement.amount.cents,
            movement.amount.currency,
            movement.counterparty ?? null,
            movement.description,
            movement.source.sourceId,
            movement.source.rawRecordId,
            movement.source.locator ?? null,
            JSON.stringify(movement.metadata),
            movement.runId ?? null,
          ],
        );
        // `rowCount` is 1 for both paths, so the insert is distinguished by
        // whether the command actually created a row.
        if (result.command === 'INSERT' && result.rowCount === 1) inserted += 1;
      }
      return { inserted, updated: movements.length - inserted };
    });
  }

  async findById(id: MovementId): Promise<Movement | undefined> {
    const { rows } = await this.db.query<MovementRow>('select * from movements where id = $1', [id]);
    return rows[0] ? toMovement(rows[0]) : undefined;
  }

  async findByAccount(account: AccountId, range?: DateRange): Promise<Movement[]> {
    const { rows } = range
      ? await this.db.query<MovementRow>(
          `select * from movements
           where account_id = $1 and value_date between $2 and $3
           order by value_date, id`,
          [account, range.from.toString(), range.to.toString()],
        )
      : await this.db.query<MovementRow>(
          'select * from movements where account_id = $1 order by value_date, id',
          [account],
        );
    return rows.map(toMovement);
  }

  async findByExternalId(externalId: string): Promise<Movement[]> {
    const { rows } = await this.db.query<MovementRow>(
      'select * from movements where external_id = $1 order by value_date, id',
      [externalId],
    );
    return rows.map(toMovement);
  }

  async countByAccount(account: AccountId): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'select count(*)::text as count from movements where account_id = $1',
      [account],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

type RunRow = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  ruleset_version: string;
  range_from: Date;
  range_to: Date;
  input_hashes: Record<string, string>;
};

export class PgRunRepository implements RunRepository {
  constructor(private readonly db: PgClient) {}

  async create(run: {
    id: RunId;
    startedAt: string;
    rulesetVersion: string;
    /** The period asked for. Placeholder dates made every run look identical. */
    from: string;
    to: string;
  }): Promise<void> {
    await this.db.query(
      `insert into runs (id, started_at, ruleset_version, range_from, range_to)
       values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
      [run.id, run.startedAt, run.rulesetVersion, run.from, run.to],
    );
  }

  async findById(id: RunId) {
    const { rows } = await this.db.query<RunRow>('select * from runs where id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  async list(limit = 50) {
    const { rows } = await this.db.query<RunRow>(
      'select * from runs order by started_at desc limit $1',
      [limit],
    );
    return rows.map(toRun);
  }
}

/**
 * Results, stored whole.
 *
 * A report is an immutable statement about a period under one ruleset
 * version. Shredding it into columns would mean a rules change silently
 * rewrites what an old run concluded.
 */
export class PgReportStore {
  constructor(private readonly db: PgClient) {}

  async save(input: {
    runId: RunId;
    kind: 'flow' | 'erp';
    scope: string;
    rulesetVersion: string;
    report: unknown;
  }): Promise<void> {
    await this.db.query(
      `insert into reconciliation_reports (run_id, kind, scope, ruleset_version, produced_at, report)
       values ($1, $2, $3, $4, now(), $5)
       on conflict (run_id, kind, scope) do update set report = excluded.report,
                                                       produced_at = excluded.produced_at`,
      [input.runId, input.kind, input.scope, input.rulesetVersion, JSON.stringify(input.report)],
    );
  }

  async load<T>(runId: RunId, kind: 'flow' | 'erp', scope: string): Promise<T | undefined> {
    const { rows } = await this.db.query<{ report: T }>(
      'select report from reconciliation_reports where run_id = $1 and kind = $2 and scope = $3',
      [runId, kind, scope],
    );
    return rows[0]?.report;
  }

  async latest<T>(kind: 'flow' | 'erp', scope: string): Promise<T | undefined> {
    const { rows } = await this.db.query<{ report: T }>(
      `select report from reconciliation_reports
       where kind = $1 and scope = $2 order by produced_at desc limit 1`,
      [kind, scope],
    );
    return rows[0]?.report;
  }
}

// —— Row mapping

interface RawRow {
  id: string;
  source_id: string;
  origin: string;
  fetched_at: Date;
  content_hash: string;
  payload: Buffer;
  run_id: string | null;
}

interface MovementRow {
  id: string;
  account_id: string;
  external_id: string | null;
  occurred_at: Date;
  value_date: Date;
  type: string;
  amount_cents: string;
  currency: string;
  counterparty: string | null;
  description: string;
  source_id: string;
  raw_record_id: string;
  locator: string | null;
  metadata: Record<string, string>;
  run_id: string | null;
}

function toRawRecord(row: RawRow): RawRecord {
  return {
    id: rawRecordId(row.id),
    sourceId: sourceId(row.source_id),
    origin: row.origin,
    fetchedAt: Temporal.Instant.from(row.fetched_at.toISOString()),
    contentHash: row.content_hash,
    payload: new Uint8Array(row.payload),
    ...(row.run_id ? { runId: runId(row.run_id) } : {}),
  };
}

function toMovement(row: MovementRow): Movement {
  return {
    id: movementId(row.id),
    accountId: accountId(row.account_id),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    occurredAt: Temporal.Instant.from(row.occurred_at.toISOString()),
    valueDate: Temporal.PlainDate.from(toIsoDate(row.value_date)),
    type: row.type as MovementType,
    // bigint arrives as text: parsing it here keeps the domain in integers.
    amount: Money.ofCents(Number(row.amount_cents), row.currency as 'COP'),
    ...(row.counterparty ? { counterparty: row.counterparty } : {}),
    description: row.description,
    source: {
      sourceId: sourceId(row.source_id),
      rawRecordId: rawRecordId(row.raw_record_id),
      ...(row.locator ? { locator: row.locator } : {}),
    },
    metadata: row.metadata ?? {},
    ...(row.run_id ? { runId: runId(row.run_id) } : {}),
  };
}

function toRun(row: RunRow) {
  return {
    id: runId(row.id),
    startedAt: row.started_at.toISOString(),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    rulesetVersion: row.ruleset_version,
    range: { from: toIsoDate(row.range_from), to: toIsoDate(row.range_to) },
  };
}

/** `date` columns come back as a Date at local midnight; only the day matters. */
function toIsoDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
