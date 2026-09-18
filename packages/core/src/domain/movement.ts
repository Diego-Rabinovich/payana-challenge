import type { Temporal } from '@js-temporal/polyfill';
import type { AccountId, MovementId, RawRecordId, RunId, SourceId } from './ids.js';
import type { Money } from './money.js';

/**
 * What happened to the money — not who did it, and not where it came from.
 *
 * Those two are already carried by `accountId` and `counterparty`, so encoding
 * them here would duplicate them. The test this taxonomy has to pass: adding a
 * source must not add a type. A POS settlement is a TRANSFER_IN on a bank
 * account, exactly like a gateway settlement; what differs is the account and
 * the counterparty, which is what the reconciliation reads.
 *
 * Mapping to accounting codes lives in config/odoo-accounts.json. The domain
 * does not know the ERP's chart. See ADR-0002.
 */
export const MOVEMENT_TYPES = [
  'CHARGE', // a sale was collected
  'REFUND', // a sale was returned
  'CHARGEBACK', // a sale was disputed back
  'FEE', // a service charge was taken
  'TAX', // tax levied on a charge
  'WITHHOLDING', // tax withheld at source
  'INTEREST', // interest earned on a balance
  'TRANSFER_IN', // funds arrived from another account
  'TRANSFER_OUT', // funds left towards another account
  'OTHER', // recognised but unclassified; never hidden
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * Where a movement came from: the citation back to the raw bytes it was
 * derived from. RawRecord is the fact, Movement is the interpretation, and
 * this is the arrow between them. See ADR-0002.
 */
export interface SourceRef {
  readonly sourceId: SourceId;
  readonly rawRecordId: RawRecordId;
  /** Position inside the record, e.g. "page=1;row=14" or a transaction id. */
  readonly locator?: string;
}

/** Raw bytes exactly as received, stored before any interpretation. */
export interface RawRecord {
  readonly id: RawRecordId;
  readonly sourceId: SourceId;
  /** Where it came from: "file:data/fixtures/…", an URL, or "webhook". */
  readonly origin: string;
  readonly fetchedAt: Temporal.Instant;
  /** sha256 of the payload. Detects that a source changed under us. */
  readonly contentHash: string;
  readonly payload: Uint8Array | string;
  readonly runId?: RunId;
}

/** The atomic unit of the model: one signed money movement in one account. */
export interface Movement {
  readonly id: MovementId;
  readonly accountId: AccountId;
  /** Identifier in the source system; shared by the four parts of one sale. */
  readonly externalId?: string;
  readonly occurredAt: Temporal.Instant;
  /** Accounting date in the business timezone. Decides batch membership. */
  readonly valueDate: Temporal.PlainDate;
  readonly type: MovementType;
  /** Signed: inflows positive, outflows negative. */
  readonly amount: Money;
  /**
   * The other party, as the source names it — "WOMPI S.A.S.", "DRUO SAS".
   *
   * A fact read off the document, never a conclusion. Deciding that a given
   * counterparty *is* the channel we expected is the reconciliation's job; if
   * ingestion decided it, the confidence score would be scoring itself.
   */
  readonly counterparty?: string;
  /** Raw descriptor from the source, kept verbatim for explanations. */
  readonly description: string;
  readonly source: SourceRef;
  /** Source-specific fields, kept out of the core model on purpose. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly runId?: RunId;
}

/** What a parser returns, before the pipeline assigns a deterministic id. */
export type CanonicalRecord = Omit<Movement, 'id' | 'runId'>;
