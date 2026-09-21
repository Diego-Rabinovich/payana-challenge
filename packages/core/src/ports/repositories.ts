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
/**
 * Una fila de `runs`, con el período que esa corrida pidió.
 *
 * El rango no estaba en este tipo y la implementación igual lo devolvía, así
 * que quien quisiera recortar algo al período de una corrida tenía que
 * castear. Ahora el puerto dice lo que hay.
 */
export interface StoredRun {
  readonly id: RunId;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly rulesetVersion: string;
  readonly range: { readonly from: string; readonly to: string };
}

export interface RunRepository {
  create(run: {
    id: RunId;
    startedAt: string;
    rulesetVersion: string;
    from: string;
    to: string;
  }): Promise<void>;
  findById(id: RunId): Promise<StoredRun | undefined>;
  /** Más reciente primero, que es el orden en que alguien las quiere ver. */
  list(limit?: number): Promise<StoredRun[]>;
}
