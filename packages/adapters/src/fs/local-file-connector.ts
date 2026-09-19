import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import {
  type DateRange,
  type RawRecord,
  type SourceConnector,
  type SourceId,
  deriveRawRecordId,
  sha256,
} from '@aa/core';

/**
 * Files on disk as a source.
 *
 * The transport for anything that arrives as a document: the monthly bank
 * statements today, a panel export or a new channel's CSV tomorrow. Because
 * transport and format are separate axes, none of those needs a connector of
 * its own — only a parser. See ADR-0003.
 *
 * The range is not applied here. A statement's period lives inside the file,
 * and deciding which months to read by their filenames would be guessing;
 * the parser reads the real period and the pipeline keeps what falls in range.
 */
export class LocalFileConnector implements SourceConnector {
  constructor(
    readonly id: SourceId,
    private readonly directory: string,
    private readonly extension: string,
  ) {}

  async *fetch(_range: DateRange): AsyncIterable<RawRecord> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      // A missing directory is an empty source, not a crash: a run that has
      // no statements yet still has Wompi and Odoo to reconcile.
      return;
    }

    for (const name of names.filter((file) => file.endsWith(this.extension)).sort()) {
      const payload = new Uint8Array(await readFile(join(this.directory, name)));
      const contentHash = sha256(payload);

      yield {
        id: deriveRawRecordId(this.id, contentHash),
        sourceId: this.id,
        origin: `file:${name}`,
        fetchedAt: Temporal.Now.instant(),
        contentHash,
        payload,
      };
    }
  }
}
