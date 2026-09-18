import { Temporal } from '@js-temporal/polyfill';
import type { AccountId, MovementId, RawRecordId, RunId, SourceId } from '../domain/ids.js';
import type { Movement, RawRecord } from '../domain/movement.js';
import type {
  MovementRepository,
  RawRecordRepository,
  RunRepository,
} from '../ports/repositories.js';
import type { DateRange } from '../ports/source-connector.js';

/**
 * In-memory implementations, used by the domain tests and by the contract
 * suites. They live beside the ports rather than in `adapters` so `core` is
 * testable on its own: no Postgres, no Docker, no network.
 */

export class InMemoryRawRecordRepository implements RawRecordRepository {
  private readonly records = new Map<RawRecordId, RawRecord>();

  async upsert(record: RawRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async findById(id: RawRecordId): Promise<RawRecord | undefined> {
    return this.records.get(id);
  }

  async findBySource(sourceId: SourceId): Promise<RawRecord[]> {
    return [...this.records.values()].filter((r) => r.sourceId === sourceId);
  }

  get size(): number {
    return this.records.size;
  }
}

export class InMemoryMovementRepository implements MovementRepository {
  private readonly movements = new Map<MovementId, Movement>();

  async upsertMany(incoming: readonly Movement[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const movement of incoming) {
      if (this.movements.has(movement.id)) updated += 1;
      else inserted += 1;
      this.movements.set(movement.id, movement);
    }
    return { inserted, updated };
  }

  async findById(id: MovementId): Promise<Movement | undefined> {
    return this.movements.get(id);
  }

  async findByAccount(accountId: AccountId, range?: DateRange): Promise<Movement[]> {
    return [...this.movements.values()]
      .filter((m) => m.accountId === accountId && withinRange(m, range))
      .sort(byValueDateThenId);
  }

  async findByExternalId(externalId: string): Promise<Movement[]> {
    return [...this.movements.values()]
      .filter((m) => m.externalId === externalId)
      .sort(byValueDateThenId);
  }

  async countByAccount(accountId: AccountId): Promise<number> {
    return [...this.movements.values()].filter((m) => m.accountId === accountId).length;
  }

  get size(): number {
    return this.movements.size;
  }
}

type RunRecord = { id: RunId; startedAt: string; rulesetVersion: string };

export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<RunId, RunRecord>();

  async create(run: RunRecord): Promise<void> {
    this.runs.set(run.id, run);
  }

  async findById(id: RunId): Promise<RunRecord | undefined> {
    return this.runs.get(id);
  }

  async list(limit = 50): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
      .slice(0, limit);
  }
}

function withinRange(movement: Movement, range?: DateRange): boolean {
  if (!range) return true;
  return (
    Temporal.PlainDate.compare(movement.valueDate, range.from) >= 0 &&
    Temporal.PlainDate.compare(movement.valueDate, range.to) <= 0
  );
}

function byValueDateThenId(a: Movement, b: Movement): number {
  const byDate = Temporal.PlainDate.compare(a.valueDate, b.valueDate);
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
