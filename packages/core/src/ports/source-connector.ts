import type { Temporal } from '@js-temporal/polyfill';
import type { SourceId } from '../domain/ids.js';
import type { RawRecord } from '../domain/movement.js';

export interface DateRange {
  readonly from: Temporal.PlainDate;
  readonly to: Temporal.PlainDate;
}

/**
 * How raw bytes are obtained. One of the two orthogonal ingestion axes; the
 * other is RecordParser. Keeping them apart is what lets Wompi arrive by API,
 * by panel export and by webhook without duplicating either side. ADR-0003.
 *
 * Implementations: LocalFileConnector, HttpApiConnector, WebhookInboxConnector,
 * OdooJournalConnector.
 */
export interface SourceConnector {
  readonly id: SourceId;
  /**
   * Yields raw records for the range. Lazy so a year of statements does not
   * have to be held in memory at once. An empty range yields nothing and must
   * not throw.
   */
  fetch(range: DateRange): AsyncIterable<RawRecord>;
}
