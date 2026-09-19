import type { ErpEntry } from '../domain/erp-entry.js';
import type { ErpCorrection } from '../domain/erp-correction.js';
import type { DateRange } from './source-connector.js';

/**
 * The accounting system, as the domain needs it.
 *
 * Reading is unrestricted; creating is deliberate. Existing entries are never
 * modified or deleted — a discrepancy gets reported, and correcting one is a
 * human decision. See ADR-0006.
 */
export interface ErpGateway {
  readJournal(journalId: number, range: DateRange): Promise<ErpEntry[]>;

  /** Looks up our idempotency key, so a rerun updates nothing twice. */
  findByRef(ref: string): Promise<ErpEntry | undefined>;

  /**
   * Records the correction as a draft and returns its id. The correction is
   * single entry; how an ERP chooses to represent it is the adapter's problem.
   * Posting is a separate, explicit action: a draft is reversible, a posted
   * entry much less so.
   */
  createDraftEntry(correction: ErpCorrection): Promise<string>;
}

/** Whether this gateway is allowed to write at all, and why not if it is not. */
export interface ErpWritePolicy {
  readonly enabled: boolean;
  readonly reason?: string;
}
