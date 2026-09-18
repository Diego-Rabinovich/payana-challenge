import type { Evidence } from '../domain/evidence.js';
import type { CanonicalRecord, RawRecord } from '../domain/movement.js';

export interface ParseResult {
  readonly records: readonly CanonicalRecord[];
  /**
   * What the parser observed while reading: integrity checks that passed,
   * transactions excluded and why, descriptors it could not classify. This is
   * how ingestion stays explainable rather than silently lossy.
   */
  readonly notes: readonly Evidence[];
}

/**
 * How raw bytes are interpreted. The second ingestion axis (ADR-0003).
 *
 * Every implementation owes three things (docs/ADDING-A-SOURCE.md):
 *  1. normalise amounts to cents, never pesos or floats;
 *  2. populate SourceRef.locator precisely enough to find the original row;
 *  3. validate an integrity invariant and throw ParseIntegrityError if it
 *     breaks — partial results are not returned. See ADR-0009.
 */
export interface RecordParser {
  readonly id: string;
  /** Sniffer: does this parser recognise the document? Enables layout A/B. */
  canParse(raw: RawRecord): boolean;
  parse(raw: RawRecord): ParseResult;
}

/**
 * Resolves which parser owns a document. Registering a new one is a one-line
 * change here plus the parser itself — no change to the pipeline.
 */
export interface ParserRegistry {
  resolve(raw: RawRecord): RecordParser;
}
