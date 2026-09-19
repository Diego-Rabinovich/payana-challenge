import { Temporal } from '@js-temporal/polyfill';
import {
  type AccountId,
  type CanonicalRecord,
  type Evidence,
  Money,
  ParseIntegrityError,
  type ParseResult,
  type RawRecord,
  type RecordParser,
  evidence,
} from '@aa/core';
import { BANCOLOMBIA_STATEMENT, parseAmount } from '../shared/decimal-text.js';
import { type DescriptorConfig, classifyDescriptor } from './descriptor-rules.js';
import { type Row, cellIn, extractRows, valueAfter } from './pdf-rows.js';

/**
 * Column boundaries, in PDF points.
 *
 * A statement is a fixed-width report, so the columns are positional. Naming
 * them here rather than scattering magic numbers is what makes a second layout
 * a new constant object instead of a rewrite.
 */
const LAYOUT = {
  date: [0, 90],
  description: [90, 300],
  value: [380, 500],
  balance: [500, 620],
} as const;

const BUSINESS_TIMEZONE = 'America/Bogota';

export interface StatementParserOptions {
  readonly accountId: AccountId;
  readonly descriptors: DescriptorConfig;
  /** Slack on the balance chain, in cents. Zero: the bank's own arithmetic. */
  readonly toleranceCents?: number;
}

interface StatementHeader {
  readonly accountNumber: string;
  readonly from: Temporal.PlainDate;
  readonly to: Temporal.PlainDate;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly totalCredits: Money;
  readonly totalDebits: Money;
}

/**
 * Bancolombia's monthly statement.
 *
 * The riskiest adapter in the system, and the one that earns the most: a PDF
 * changes layout without warning and loses rows across page breaks, and a
 * credulous parser produces an incomplete ledger that *looks* right. That is
 * the worst failure mode there is — not a visible error but a confident wrong
 * answer.
 *
 * The document defends itself, if you let it. It carries a running balance and
 * a summary block, which give two independent checks for free; either one
 * failing rejects the whole parse rather than returning what was readable.
 * See ADR-0009.
 */
export class BancolombiaStatementParser implements RecordParser {
  readonly id = 'bancolombia-statement';

  constructor(private readonly options: StatementParserOptions) {}

  canParse(raw: RawRecord): boolean {
    if (typeof raw.payload === 'string') return false;
    // Cheap sniff on the PDF magic bytes; the real recognition happens in
    // parse, where the header either reads or the document is not ours.
    return raw.payload[0] === 0x25 && raw.payload[1] === 0x50;
  }

  async parse(raw: RawRecord): Promise<ParseResult> {
    if (typeof raw.payload === 'string') {
      throw new ParseIntegrityError('Statement payload is not binary', { sourceId: raw.sourceId });
    }

    const rows = await extractRows(raw.payload);
    const header = this.readHeader(rows, raw);
    const entries = this.readEntries(rows, header, raw);

    const notes = [
      ...this.verifyBalanceChain(entries, header, raw),
      ...this.verifySummaryTotals(entries, header, raw),
    ];

    const records = entries.map((entry) => this.toRecord(entry, raw));
    return {
      records,
      notes: [...notes, ...this.unclassifiedNotes(entries)],
    };
  }

  // —— Header

  private readHeader(rows: readonly Row[], raw: RawRecord): StatementHeader {
    const period = rows
      .map((row) => /DESDE:\s*(\d{4})\/(\d{2})\/(\d{2})\s*HASTA:\s*(\d{4})\/(\d{2})\/(\d{2})/.exec(row.line))
      .find((match): match is RegExpExecArray => match !== null);

    if (!period) {
      throw new ParseIntegrityError('Statement has no DESDE/HASTA period', {
        sourceId: raw.sourceId,
      });
    }

    const accountNumber = /N[ÚU]MERO\s+(\d+)/.exec(rows.map((row) => row.line).join(' '))?.[1];

    return {
      accountNumber: accountNumber ?? '',
      from: Temporal.PlainDate.from(`${period[1]}-${period[2]}-${period[3]}`),
      to: Temporal.PlainDate.from(`${period[4]}-${period[5]}-${period[6]}`),
      openingBalance: this.summaryValue(rows, 'SALDO ANTERIOR', raw),
      closingBalance: this.summaryValue(rows, 'SALDO ACTUAL', raw),
      totalCredits: this.summaryValue(rows, 'TOTAL ABONOS', raw),
      totalDebits: this.summaryValue(rows, 'TOTAL CARGOS', raw),
    };
  }

  private summaryValue(rows: readonly Row[], label: string, raw: RawRecord): Money {
    for (const row of rows) {
      const value = valueAfter(row, label);
      if (value) return parseAmount(value, BANCOLOMBIA_STATEMENT);
      // The summary puts label and value on adjacent baselines, not always
      // the same one, so fall back to the row below.
      if (row.line.toUpperCase().includes(label)) {
        const next = rows[rows.indexOf(row) + 1];
        const candidate = next?.cells.find((cell) => /^[$\s-]*[\d,]+\.\d{2}$/.test(cell.text));
        if (candidate) return parseAmount(candidate.text, BANCOLOMBIA_STATEMENT);
      }
    }
    throw new ParseIntegrityError(`Statement summary has no ${label}`, { sourceId: raw.sourceId });
  }

  // —— Entries

  private readEntries(
    rows: readonly Row[],
    header: StatementHeader,
    raw: RawRecord,
  ): StatementEntry[] {
    const entries: StatementEntry[] = [];

    for (const row of rows) {
      const rawDate = cellIn(row, ...LAYOUT.date);
      const description = cellIn(row, ...LAYOUT.description);
      const rawValue = cellIn(row, ...LAYOUT.value);
      const rawBalance = cellIn(row, ...LAYOUT.balance);

      if (!rawDate || !description || !rawValue || !rawBalance) continue;
      if (!/^\d{1,2}\/\d{2}$/.test(rawDate)) continue;

      entries.push({
        locator: `page=${row.page};y=${row.y}`,
        valueDate: this.resolveDate(rawDate, header),
        description,
        amount: parseAmount(rawValue, BANCOLOMBIA_STATEMENT),
        balance: parseAmount(rawBalance, BANCOLOMBIA_STATEMENT),
      });
    }

    if (entries.length === 0) {
      throw new ParseIntegrityError('Statement contains no readable movement rows', {
        sourceId: raw.sourceId,
      });
    }
    return entries;
  }

  /**
   * Rows carry `d/mm` with no year, so it comes from the period.
   *
   * The January statement opens on 31 December, so a row whose month is lower
   * than the period's start month belongs to the closing year. Not a
   * hypothetical: it is the first row of the first file.
   */
  private resolveDate(raw: string, header: StatementHeader): Temporal.PlainDate {
    const [day, month] = raw.split('/').map(Number) as [number, number];
    const year = month < header.from.month ? header.to.year : header.from.year;
    return Temporal.PlainDate.from({ year, month, day });
  }

  // —— Integrity

  /**
   * Every row's balance must be the previous one plus its value, from the
   * opening balance through to the closing one. This is what catches a row
   * lost at a page break — the single most likely way to lose money silently.
   */
  private verifyBalanceChain(
    entries: readonly StatementEntry[],
    header: StatementHeader,
    raw: RawRecord,
  ): Evidence[] {
    const tolerance = this.options.toleranceCents ?? 0;
    let running = header.openingBalance;

    for (const entry of entries) {
      running = running.plus(entry.amount);
      if (Math.abs(running.minus(entry.balance).cents) > tolerance) {
        throw new ParseIntegrityError('Balance chain breaks', {
          sourceId: raw.sourceId,
          locator: entry.locator,
          expected: running.toString(),
          observed: entry.balance.toString(),
        });
      }
      running = entry.balance;
    }

    if (Math.abs(running.minus(header.closingBalance).cents) > tolerance) {
      throw new ParseIntegrityError('Balance chain does not close on SALDO ACTUAL', {
        sourceId: raw.sourceId,
        expected: header.closingBalance.toString(),
        observed: running.toString(),
      });
    }

    return [
      evidence('BALANCE_CHAIN_OK', 'INGESTION', true, {
        expected: header.closingBalance.toString(),
        observed: running.toString(),
        detail: `${entries.length} filas`,
      }),
    ];
  }

  /** A second, independent check: the summary's own totals. */
  private verifySummaryTotals(
    entries: readonly StatementEntry[],
    header: StatementHeader,
    raw: RawRecord,
  ): Evidence[] {
    const credits = Money.sum(entries.filter((e) => e.amount.isPositive()).map((e) => e.amount));
    const debits = Money.sum(entries.filter((e) => e.amount.isNegative()).map((e) => e.amount));
    const tolerance = this.options.toleranceCents ?? 0;

    const creditsOff = Math.abs(credits.minus(header.totalCredits).cents) > tolerance;
    const debitsOff = Math.abs(debits.abs().minus(header.totalDebits).cents) > tolerance;

    if (creditsOff || debitsOff) {
      throw new ParseIntegrityError('Summary totals disagree with the rows', {
        sourceId: raw.sourceId,
        expected: `abonos ${header.totalCredits.toString()} / cargos ${header.totalDebits.toString()}`,
        observed: `abonos ${credits.toString()} / cargos ${debits.abs().toString()}`,
      });
    }

    return [
      evidence('SUMMARY_TOTALS_OK', 'INGESTION', true, {
        expected: header.totalCredits.toString(),
        observed: credits.toString(),
      }),
    ];
  }

  private unclassifiedNotes(entries: readonly StatementEntry[]): Evidence[] {
    const unknown = new Set<string>();
    for (const entry of entries) {
      const classification = classifyDescriptor(entry.description, this.options.descriptors);
      if (!classification.recognised) unknown.add(entry.description);
    }

    return [...unknown].map((description) =>
      evidence('DESCRIPTOR_UNCLASSIFIED', 'INGESTION', false, { observed: description }),
    );
  }

  // —— Mapping

  private toRecord(entry: StatementEntry, raw: RawRecord): CanonicalRecord {
    const classification = classifyDescriptor(entry.description, this.options.descriptors);

    return {
      accountId: this.options.accountId,
      occurredAt: entry.valueDate.toZonedDateTime(BUSINESS_TIMEZONE).toInstant(),
      valueDate: entry.valueDate,
      type: classification.type,
      amount: entry.amount,
      ...(classification.counterparty ? { counterparty: classification.counterparty } : {}),
      description: entry.description,
      source: {
        sourceId: raw.sourceId,
        rawRecordId: raw.id,
        locator: entry.locator,
      },
      metadata: {
        rule: classification.ruleId,
        runningBalance: String(entry.balance.cents),
      },
    };
  }
}

interface StatementEntry {
  readonly locator: string;
  readonly valueDate: Temporal.PlainDate;
  readonly description: string;
  readonly amount: Money;
  readonly balance: Money;
}
