import type { AccountId, MovementId, RawRecordId, RunId, SourceId } from '../domain/ids.js';
import type { Movement, RawRecord } from '../domain/movement.js';
import type { DateRange } from './source-connector.js';

export interface RawRecordRepository {
  /** Idempotent by content-derived id: storing twice stores once. */
  upsert(record: RawRecord): Promise<void>;
  findById(id: RawRecordId): Promise<RawRecord | undefined>;
  findBySource(sourceId: SourceId): Promise<RawRecord[]>;
}

export interface MovementRepository {
  /** Idempotent by content-derived id. Returns how many were new. */
  upsertMany(movements: readonly Movement[]): Promise<{ inserted: number; updated: number }>;
  findById(id: MovementId): Promise<Movement | undefined>;
  /** Ordered by value date, then id. Deterministic for the same input. */
  findByAccount(accountId: AccountId, range?: DateRange): Promise<Movement[]>;
  findByExternalId(externalId: string): Promise<Movement[]>;
  countByAccount(accountId: AccountId): Promise<number>;
}

/** Runs are append-only: they are never overwritten, only compared. */
export interface RunRepository {
  create(run: { id: RunId; startedAt: string; rulesetVersion: string }): Promise<void>;
  findById(id: RunId): Promise<{ id: RunId; startedAt: string; rulesetVersion: string } | undefined>;
  list(limit?: number): Promise<{ id: RunId; startedAt: string; rulesetVersion: string }[]>;
}
