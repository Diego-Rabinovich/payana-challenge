import type { Evidence } from '../domain/evidence.js';
import { DomainError, ParseIntegrityError, UnknownLayoutError } from '../domain/errors.js';
import { deriveMovementId } from '../domain/identity.js';
import type { RunId, SourceId } from '../domain/ids.js';
import type { Movement, MovementType } from '../domain/movement.js';
import type { ConnectorRegistry } from '../ports/connector-registry.js';
import type { ParserRegistry } from '../ports/record-parser.js';
import type { MovementRepository, RawRecordRepository } from '../ports/repositories.js';
import type { DateRange } from '../ports/source-connector.js';

export interface RejectedRecord {
  readonly origin: string;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface IngestionReport {
  readonly sourceId: SourceId;
  readonly runId: RunId;
  readonly rawRecordsRead: number;
  readonly movementsInserted: number;
  readonly movementsUpdated: number;
  readonly byType: Readonly<Partial<Record<MovementType, number>>>;
  /** What the parsers observed: integrity checks, exclusions, unknown descriptors. */
  readonly notes: readonly Evidence[];
  /** Documents that failed their own integrity checks and were not ingested. */
  readonly rejected: readonly RejectedRecord[];
}

/**
 * The ingestion pipeline, written once for every source:
 *   fetch → store raw → resolve parser → parse → derive ids → upsert.
 *
 * Adding a source touches adapters and config, never this file. ADR-0003.
 */
export class IngestSource {
  constructor(
    private readonly connectors: ConnectorRegistry,
    private readonly parsers: ParserRegistry,
    private readonly rawRecords: RawRecordRepository,
    private readonly movements: MovementRepository,
  ) {}

  async execute(input: {
    sourceId: SourceId;
    range: DateRange;
    runId: RunId;
  }): Promise<IngestionReport> {
    const connector = this.connectors.get(input.sourceId);

    const notes: Evidence[] = [];
    const rejected: RejectedRecord[] = [];
    const pending: Movement[] = [];
    let rawRecordsRead = 0;

    for await (const raw of connector.fetch(input.range)) {
      rawRecordsRead += 1;
      await this.rawRecords.upsert({ ...raw, runId: input.runId });

      try {
        const result = this.parsers.resolve(raw).parse(raw);
        notes.push(...result.notes);
        for (const record of result.records) {
          pending.push({ ...record, id: deriveMovementId(record), runId: input.runId });
        }
      } catch (error) {
        // Fail closed, per document: a file that fails its own control checks
        // contributes nothing rather than a silently incomplete ledger. Other
        // documents still ingest, and the rejection is reported loudly so the
        // gap is never mistaken for "there was no activity". ADR-0009.
        if (error instanceof ParseIntegrityError || error instanceof UnknownLayoutError) {
          rejected.push({
            origin: raw.origin,
            code: error.code,
            message: error.message,
            context: error.context,
          });
          continue;
        }
        throw error;
      }
    }

    // Deterministic ids mean re-ingesting the same document is a no-op, so
    // this is safe to run on every pass. F01-T11.
    const { inserted, updated } = await this.movements.upsertMany(pending);

    return {
      sourceId: input.sourceId,
      runId: input.runId,
      rawRecordsRead,
      movementsInserted: inserted,
      movementsUpdated: updated,
      byType: countByType(pending),
      notes,
      rejected,
    };
  }
}

function countByType(movements: readonly Movement[]): Partial<Record<MovementType, number>> {
  const counts: Partial<Record<MovementType, number>> = {};
  for (const movement of movements) {
    counts[movement.type] = (counts[movement.type] ?? 0) + 1;
  }
  return counts;
}

/** True when a failure is one the pipeline is expected to contain and report. */
export function isRecoverableIngestionError(error: unknown): error is DomainError {
  return error instanceof ParseIntegrityError || error instanceof UnknownLayoutError;
}
