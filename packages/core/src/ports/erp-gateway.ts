import type { Temporal } from '@js-temporal/polyfill';
import type { ErpEntry, ErpEntryState } from '../domain/erp-entry.js';
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

  /**
   * Removes an entry this system created, by its idempotency key.
   *
   * Exists so that creating one is reversible. An implementation must refuse
   * anything it did not create, anything already posted, and anything outside
   * the books it was given — undoing is not a licence to delete.
   * Returns false when there was nothing to remove.
   */
  deleteDraftEntry(ref: string): Promise<boolean>;

  /**
   * Los asientos que este sistema dejó escritos en un diario.
   *
   * Existe para que la consola pueda decir "esto ya lo creaste" despues de
   * recargar. Se pregunta al ERP en vez de anotarlo de nuestro lado: si un
   * contador lo contabilizo o lo borro, la respuesta cambia, y una marca que
   * miente es peor que no tener marca.
   */
  listOwnEntries(journalId: number): Promise<readonly OwnEntry[]>;
}

/** Un asiento nuestro, como esta hoy en el ERP. Sin lineas: es una marca. */
export interface OwnEntry {
  /** Nuestra clave de idempotencia; por eso sabemos que es nuestro. */
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly state: ErpEntryState;
  readonly date: Temporal.PlainDate;
}

/** Whether this gateway is allowed to write at all, and why not if it is not. */
export interface ErpWritePolicy {
  readonly enabled: boolean;
  readonly reason?: string;
}
