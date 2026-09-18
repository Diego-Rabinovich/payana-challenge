import { createHash } from 'node:crypto';
import {
  type BatchId,
  type MatchId,
  type MovementId,
  type RawRecordId,
  type SourceId,
  matchId,
  movementId,
  rawRecordId,
} from './ids.js';
import type { CanonicalRecord } from './movement.js';

/**
 * Ids are derived from content, not generated. Re-ingesting the same file
 * therefore produces the same ids and duplicates nothing, and an id quoted in
 * an explanation always refers to the same thing. See ADR-0002.
 *
 * This is why there is no IdGenerator port: it is a pure function.
 */
const ID_LENGTH = 16;

export function deriveMovementId(record: CanonicalRecord): MovementId {
  const canonical = [
    record.source.sourceId,
    record.externalId ?? '',
    record.valueDate.toString(),
    record.amount.cents.toString(),
    record.type,
    // Disambiguates the several lines a statement can have on one day with the
    // same amount and type; the locator is unique within a raw record.
    record.source.locator ?? '',
  ].join('|');

  return movementId(`mov_${sha256(canonical).slice(0, ID_LENGTH)}`);
}

export function deriveRawRecordId(source: SourceId, contentHash: string): RawRecordId {
  return rawRecordId(`raw_${sha256(`${source}|${contentHash}`).slice(0, ID_LENGTH)}`);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable across runs, so a rerun updates a match instead of duplicating it. */
export function deriveMatchId(batch: BatchId, depositId?: MovementId): MatchId {
  return matchId(`mat_${sha256(`${batch}|${depositId ?? 'none'}`).slice(0, ID_LENGTH)}`);
}
