import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it } from 'vitest';
import { ParseIntegrityError } from '../src/domain/errors.js';
import { evidence } from '../src/domain/evidence.js';
import { type SourceId, runId, sourceId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import type { RawRecord } from '../src/domain/movement.js';
import type { ConnectorRegistry } from '../src/ports/connector-registry.js';
import type { ParserRegistry, RecordParser } from '../src/ports/record-parser.js';
import type { SourceConnector } from '../src/ports/source-connector.js';
import {
  InMemoryMovementRepository,
  InMemoryRawRecordRepository,
} from '../src/testing/in-memory-repositories.js';
import { IngestSource } from '../src/usecases/ingest-source.js';
import { WOMPI_ACCOUNT, aCanonicalRecord, aRawRecord } from '../src/testing/builders.js';

const SOURCE = sourceId('test:source');
const RUN = runId('run_test');
const RANGE = {
  from: Temporal.PlainDate.from('2026-04-01'),
  to: Temporal.PlainDate.from('2026-04-30'),
};

function connectorFor(records: RawRecord[]): ConnectorRegistry {
  const connector: SourceConnector = {
    id: SOURCE,
    async *fetch() {
      yield* records;
    },
  };
  return {
    get: (id: SourceId) => {
      if (id !== SOURCE) throw new Error(`unknown source ${id}`);
      return connector;
    },
    ids: () => [SOURCE],
  };
}

function registryFor(parser: RecordParser): ParserRegistry {
  return { resolve: () => parser };
}

describe('IngestSource', () => {
  let rawRecords: InMemoryRawRecordRepository;
  let movements: InMemoryMovementRepository;

  beforeEach(() => {
    rawRecords = new InMemoryRawRecordRepository();
    movements = new InMemoryMovementRepository();
  });

  it('stores the raw record before interpreting it', async () => {
    const raw = aRawRecord();
    const useCase = new IngestSource(
      connectorFor([raw]),
      registryFor({ id: 'noop', canParse: () => true, parse: () => ({ records: [], notes: [] }) }),
      rawRecords,
      movements,
    );

    await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });

    // The fact is kept even when the interpretation yields nothing: that is
    // what allows re-parsing later without going back to the source.
    expect(rawRecords.size).toBe(1);
  });

  it('decomposes a sale into its four parts and counts them by type (F01-T07)', async () => {
    const parser: RecordParser = {
      id: 'wompi',
      canParse: () => true,
      parse: () => ({
        records: [
          aCanonicalRecord({ type: 'CHARGE', amount: Money.ofCents(31_754_900), source: locator('charge') }),
          aCanonicalRecord({ type: 'FEE', amount: Money.ofCents(-786_240), source: locator('fee') }),
          aCanonicalRecord({ type: 'TAX', amount: Money.ofCents(-149_385), source: locator('tax') }),
          aCanonicalRecord({ type: 'WITHHOLDING', amount: Money.ofCents(-476_323), source: locator('wht') }),
        ],
        notes: [],
      }),
    };
    const useCase = new IngestSource(connectorFor([aRawRecord()]), registryFor(parser), rawRecords, movements);

    const report = await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });

    expect(report.movementsInserted).toBe(4);
    expect(report.byType).toEqual({ CHARGE: 1, FEE: 1, TAX: 1, WITHHOLDING: 1 });

    const stored = await movements.findByAccount(WOMPI_ACCOUNT);
    expect(Money.sum(stored.map((m) => m.amount)).cents).toBe(30_342_952);
  });

  it('is idempotent: ingesting the same document twice does not duplicate (F01-T11)', async () => {
    const parser: RecordParser = {
      id: 'wompi',
      canParse: () => true,
      parse: () => ({ records: [aCanonicalRecord()], notes: [] }),
    };
    const useCase = new IngestSource(connectorFor([aRawRecord()]), registryFor(parser), rawRecords, movements);

    const first = await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });
    const second = await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });

    expect(first.movementsInserted).toBe(1);
    expect(second.movementsInserted).toBe(0);
    expect(second.movementsUpdated).toBe(1);
    expect(movements.size).toBe(1);
  });

  it('propagates parser notes so ingestion stays explainable', async () => {
    const parser: RecordParser = {
      id: 'bancolombia',
      canParse: () => true,
      parse: () => ({
        records: [],
        notes: [
          evidence('BALANCE_CHAIN_OK', 'INGESTION', true),
          evidence('DESCRIPTOR_UNCLASSIFIED', 'INGESTION', false, {
            observed: 'PAGO INTERBANC DRUO SAS',
            locator: 'page=1;row=22',
          }),
        ],
      }),
    };
    const useCase = new IngestSource(connectorFor([aRawRecord()]), registryFor(parser), rawRecords, movements);

    const report = await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });

    expect(report.notes.map((n) => n.code)).toEqual(['BALANCE_CHAIN_OK', 'DESCRIPTOR_UNCLASSIFIED']);
  });

  describe('fail closed (ADR-0009)', () => {
    const goodRecord = aRawRecord({ origin: 'file:good.pdf' });
    const brokenRecord = aRawRecord({ origin: 'file:broken.pdf', payload: 'broken' });

    const parser: RecordParser = {
      id: 'statement',
      canParse: () => true,
      parse: (raw) => {
        if (raw.origin === 'file:broken.pdf') {
          throw new ParseIntegrityError('Balance chain breaks at row 14', {
            sourceId: SOURCE,
            locator: 'page=1;row=14',
            expected: '393,267,975.66',
            observed: '393,281,843.66',
          });
        }
        return { records: [aCanonicalRecord()], notes: [] };
      },
    };

    it('ingests nothing from a document that fails its own integrity check', async () => {
      const useCase = new IngestSource(
        connectorFor([brokenRecord]),
        registryFor(parser),
        rawRecords,
        movements,
      );

      const report = await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });

      expect(report.movementsInserted).toBe(0);
      expect(report.rejected).toHaveLength(1);
      expect(report.rejected[0]).toMatchObject({
        origin: 'file:broken.pdf',
        code: 'PARSE_INTEGRITY',
      });
      // The rejection names the row, so it is actionable rather than annoying.
      expect(report.rejected[0]?.context).toMatchObject({ locator: 'page=1;row=14' });
    });

    it('still ingests the other documents, and says loudly which one it dropped', async () => {
      const useCase = new IngestSource(
        connectorFor([goodRecord, brokenRecord]),
        registryFor(parser),
        rawRecords,
        movements,
      );

      const report = await useCase.execute({ sourceId: SOURCE, range: RANGE, runId: RUN });

      expect(report.rawRecordsRead).toBe(2);
      expect(report.movementsInserted).toBe(1);
      expect(report.rejected).toHaveLength(1);
    });
  });
});

function locator(tag: string) {
  return { sourceId: SOURCE, rawRecordId: aRawRecord().id, locator: tag };
}
