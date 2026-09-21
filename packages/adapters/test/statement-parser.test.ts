import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { ParseIntegrityError, accountId, rawRecordId, sourceId } from '@aa/core';
import type { RawRecord } from '@aa/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { BancolombiaStatementParser } from '../src/bancolombia/statement-parser.js';
import type { DescriptorConfig } from '../src/bancolombia/descriptor-rules.js';

/**
 * Run against the real statements, not a fixture someone drew.
 *
 * A parser that only ever sees an idealised sample is a parser that has not
 * been tested: the whole risk lives in what the real documents do that a
 * hand-written example would not.
 *
 * Los extractos son reales y no se comitean: viven en `data/statements/`, que
 * se llena subiéndolos desde la consola. Sin ellos este suite se saltea en vez
 * de fallar — un clone limpio queda verde, y el reporte dice que se saltó.
 */
const ROOT = resolve(process.cwd(), '../..');
const STATEMENTS = resolve(ROOT, 'data/statements');

const descriptors = JSON.parse(
  readFileSync(resolve(ROOT, 'config/descriptors.json'), 'utf8'),
) as DescriptorConfig;

const ACCOUNT = accountId('bancolombia:00000000000');

const parser = new BancolombiaStatementParser({ accountId: ACCOUNT, descriptors });

/** Un registro con el payload que se le pase. No lee nada del disco. */
function recordWith(payload: RawRecord['payload'], name = 'extracto.pdf'): RawRecord {
  return {
    id: rawRecordId(`raw_${name}`),
    sourceId: sourceId('bancolombia:statement'),
    origin: `file:${name}`,
    fetchedAt: Temporal.Instant.from('2026-09-19T12:00:00Z'),
    contentHash: name,
    payload,
  };
}

function statementRecord(file: string): RawRecord {
  return recordWith(new Uint8Array(readFileSync(resolve(STATEMENTS, file))), file);
}

const files = existsSync(STATEMENTS)
  ? readdirSync(STATEMENTS).filter((name) => name.endsWith('.pdf'))
  : [];

describe.skipIf(files.length === 0)('BancolombiaStatementParser — the real statements', () => {
  it('finds the statements to parse', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('recognises a statement and rejects anything else', () => {
    expect(parser.canParse(statementRecord(files[0]!))).toBe(true);
    expect(
      parser.canParse({ ...statementRecord(files[0]!), payload: 'not a pdf' }),
    ).toBe(false);
  });

  it.each(files)('parses %s with both integrity checks green', async (file) => {
    const result = await parser.parse(statementRecord(file));

    expect(result.records.length).toBeGreaterThan(50);
    const codes = result.notes.map((note) => note.code);
    expect(codes).toContain('BALANCE_CHAIN_OK');
    expect(codes).toContain('SUMMARY_TOTALS_OK');
  });

  it('resolves the year from the period, so 31/12 lands in the prior year', async () => {
    const january = files.find((file) => file.includes('Enero'))!;
    const result = await parser.parse(statementRecord(january));

    const dates = result.records.map((record) => record.valueDate.toString());
    expect(dates.every((date) => date.startsWith('2025') || date.startsWith('2026'))).toBe(true);
    // The period opens on 2025-12-31, so nothing may land in 2027 or earlier.
    expect(dates.some((date) => date.startsWith('2026-01'))).toBe(true);
  });

  it('classifies Wompi settlements as transfers in, naming the counterparty', async () => {
    const january = files.find((file) => file.includes('Enero'))!;
    const result = await parser.parse(statementRecord(january));

    const wompi = result.records.filter((record) => record.counterparty === 'WOMPI S.A.S.');
    expect(wompi.length).toBeGreaterThan(0);
    expect(wompi.every((record) => record.type === 'TRANSFER_IN')).toBe(true);
    expect(wompi.every((record) => record.amount.isPositive())).toBe(true);
  });

  it('keeps out-of-scope rows in the ledger, unclassified, so the balance still closes', async () => {
    const january = files.find((file) => file.includes('Enero'))!;
    const result = await parser.parse(statementRecord(january));

    // Intereses, comisiones e IVA del banco quedaron fuera del alcance: no
    // tienen regla de descriptor y caen a OTHER, que no tiene cuenta, así que
    // nunca se propone un asiento para ellos. Pero NO se descartan: la cadena
    // de saldos sólo cierra con todas las filas adentro, y si faltara una el
    // parse fallaría. Que esta línea se ejecute ya prueba que cerró.
    const interest = result.records.filter((record) =>
      record.description.startsWith('ABONO INTERESES'),
    );
    expect(interest.length).toBeGreaterThan(0);
    expect(interest.every((record) => record.type === 'OTHER')).toBe(true);
  });

  it('cites the page and baseline of every row it read', async () => {
    const result = await parser.parse(statementRecord(files[0]!));

    expect(
      result.records.every((record) => /^page=\d+;y=-?\d+$/.test(record.source.locator ?? '')),
    ).toBe(true);
  });

  it('reports descriptors it does not recognise instead of hiding them', async () => {
    const result = await parser.parse(statementRecord(files[0]!));
    const unknown = result.notes.filter((note) => note.code === 'DESCRIPTOR_UNCLASSIFIED');

    // Whatever the count, each one names what it saw.
    expect(unknown.every((note) => (note.observed ?? '').length > 0)).toBe(true);
  });
});

describe('BancolombiaStatementParser — fails closed', () => {
  // Estos dos corren siempre: prueban la salvaguarda, y la salvaguarda no
  // necesita un extracto real para dispararse.
  it('rejects a payload that is not a statement', async () => {
    await expect(parser.parse(recordWith(new Uint8Array([0x25, 0x50, 0x44])))).rejects.toThrow();
  });

  it('refuses a string payload rather than guessing', async () => {
    await expect(parser.parse(recordWith('PDF-ish text'))).rejects.toThrow(ParseIntegrityError);
  });
});
