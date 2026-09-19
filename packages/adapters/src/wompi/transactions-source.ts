import { Temporal } from '@js-temporal/polyfill';
import {
  type AccountId,
  type CanonicalRecord,
  type DateRange,
  type Evidence,
  Money,
  ParseIntegrityError,
  type ParseResult,
  type RawRecord,
  type RecordParser,
  type SourceConnector,
  type SourceId,
  deriveRawRecordId,
  evidence,
  sha256,
} from '@aa/core';
import type { WompiClient, WompiTransaction } from './wompi-client.js';

const BUSINESS_TIMEZONE = 'America/Bogota';

/**
 * Transport: pages the API and hands each page over as one raw record.
 *
 * A page rather than a transaction, because the page is what the API actually
 * returned — and `RawRecord` is meant to be the fact as received, not a slice
 * of it we chose afterwards.
 */
export class WompiTransactionsConnector implements SourceConnector {
  constructor(
    readonly id: SourceId,
    private readonly client: WompiClient,
  ) {}

  async *fetch(range: DateRange): AsyncIterable<RawRecord> {
    const from = range.from.toString();
    const until = range.to.toString();

    for await (const page of this.client.pages(from, until)) {
      const payload = JSON.stringify(page);
      const contentHash = sha256(payload);

      yield {
        id: deriveRawRecordId(this.id, contentHash),
        sourceId: this.id,
        origin: `${this.id}?from=${from}&until=${until}&page=${page.meta.page}`,
        fetchedAt: Temporal.Now.instant(),
        contentHash,
        payload,
      };
    }
  }
}

/**
 * Format: one approved transaction becomes one `CHARGE`.
 *
 * Only one, because the API gives only the gross. The commission, its VAT and
 * the withholding are not in the payload at all, so inventing three movements
 * here would mean inventing their amounts. They are derived in Phase 2 from
 * the gap against the bank credit, where the derivation can be checked against
 * the statutory rates. See ADR-0013.
 *
 * A declined or errored transaction moves no money, and a single-entry ledger
 * records money — so it produces no movement, and the count is reported so the
 * absence is explainable rather than merely absent.
 */
export class WompiTransactionParser implements RecordParser {
  readonly id = 'wompi-transaction';

  constructor(private readonly accountId: AccountId) {}

  canParse(raw: RawRecord): boolean {
    return typeof raw.payload === 'string' && raw.payload.trimStart().startsWith('{"data"');
  }

  async parse(raw: RawRecord): Promise<ParseResult> {
    if (typeof raw.payload !== 'string') {
      throw new ParseIntegrityError('Wompi payload is not text', { sourceId: raw.sourceId });
    }

    const page = JSON.parse(raw.payload) as { data?: WompiTransaction[] };
    if (!Array.isArray(page.data)) {
      throw new ParseIntegrityError('Wompi payload has no data array', { sourceId: raw.sourceId });
    }

    const records: CanonicalRecord[] = [];
    const excluded = new Map<string, number>();

    for (const transaction of page.data) {
      if (transaction.status !== 'APPROVED') {
        excluded.set(transaction.status, (excluded.get(transaction.status) ?? 0) + 1);
        continue;
      }
      records.push(this.toCharge(transaction, raw));
    }

    return { records, notes: exclusionNotes(excluded) };
  }

  private toCharge(transaction: WompiTransaction, raw: RawRecord): CanonicalRecord {
    const finalisedAt = Temporal.Instant.from(transaction.finalized_at ?? transaction.created_at);

    return {
      accountId: this.accountId,
      externalId: transaction.reference,
      occurredAt: finalisedAt,
      // The business day, not UTC: which day a sale belongs to decides which
      // settlement it is part of.
      valueDate: finalisedAt.toZonedDateTimeISO(BUSINESS_TIMEZONE).toPlainDate(),
      type: 'CHARGE',
      amount: Money.ofCents(transaction.amount_in_cents),
      counterparty: 'WOMPI S.A.S.',
      description: `Pago aprobado ${transaction.payment_method_type ?? ''}`.trim(),
      source: {
        sourceId: raw.sourceId,
        rawRecordId: raw.id,
        locator: transaction.id,
      },
      metadata: {
        transactionId: transaction.id,
        paymentMethod: transaction.payment_method_type ?? 'UNKNOWN',
      },
    };
  }
}

function exclusionNotes(excluded: ReadonlyMap<string, number>): Evidence[] {
  return [...excluded.entries()].map(([status, count]) =>
    evidence('TRANSACTION_EXCLUDED_NOT_APPROVED', 'INGESTION', false, {
      observed: status,
      detail: `${count} transacciones`,
    }),
  );
}
