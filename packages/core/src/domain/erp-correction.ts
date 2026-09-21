import type { Temporal } from '@js-temporal/polyfill';
import { ConfigurationError } from './errors.js';
import type { MovementId } from './ids.js';
import { Money } from './money.js';
import type { Movement, MovementType } from './movement.js';

/**
 * What the ERP is missing, said in the ledger's own language.
 *
 * The challenge is single entry: a movement is a signed amount, and that is
 * all the domain knows. Debits and credits belong to Odoo, so a correction
 * here lists the movements that should have been recorded — and the Odoo
 * adapter turns that into a balanced entry when it is time to speak to Odoo.
 *
 * Expressing the correction in double entry here would have been convenient
 * and wrong: the domain would have learned an accounting convention it does
 * not need, and a second ERP with a different one would have had to unpick it.
 * See ADR-0006.
 */

export interface CorrectionLine {
  /** Which canonical concept is missing or misstated. */
  readonly concept: MovementType;
  /** Signed, exactly as the ledger holds it: inflow positive, outflow negative. */
  readonly amount: Money;
  readonly label: string;
  readonly movementId?: MovementId;
}

export type CorrectionReason = 'MISSING_ENTRY' | 'INCOMPLETE_ENTRY';

export interface ErpCorrection {
  /** Idempotency key. Queried before writing, so a rerun cannot duplicate. */
  readonly ref: string;
  readonly journalKey: string;
  readonly date: Temporal.PlainDate;
  readonly reason: CorrectionReason;
  /** Concepts the existing entry lacks. Empty when the entry is absent entirely. */
  readonly missingConcepts: readonly MovementType[];
  readonly lines: readonly CorrectionLine[];
  /**
   * El otro libro nuestro donde está la otra mitad, cuando la hay.
   *
   * Un traspaso no se explica solo: la plata que entró al banco salió de
   * algún lado, y en este caso salió de un diario que también llevamos. Quién
   * es ese otro lado es una conclusión de la conciliación — se lee de la
   * contraparte del documento —, no una convención contable, así que se decide
   * acá y el adapter sólo la traduce a débito y crédito.
   */
  readonly counterpartJournalKey?: string;
  /** What actually moved into the account: gross less every deduction. */
  readonly netToAccount: Money;
  /**
   * Cómo nombrar la línea de la cuenta principal. Sin esto el adapter la llama
   * «neto acreditado» o «neto debitado», que para un asiento de deducciones —
   * donde esa línea es lo que el canal retuvo — sería falso.
   */
  readonly mainLabel?: string;
  /**
   * Sólo para mostrar: nunca se escribe en Odoo.
   *
   * Es lo que lleva el complemento de un asiento que ya existe. Agregarle
   * líneas a un asiento contabilizado no es algo que este sistema haga: se
   * muestra cómo quedaría y lo decide un contador. La referencia tampoco es
   * `mov:`, así que el guard de escritura y la API la rechazan igual.
   */
  readonly readOnly?: boolean;
}

export function idempotencyKeyFor(movementId: MovementId): string {
  return `mov:${movementId}`;
}

/**
 * Builds the correction a group of movements implies.
 *
 * Nothing is inferred: every line traces back to a movement id, and the net is
 * a subtraction rather than a judgement.
 */
export function buildCorrection(input: {
  readonly movements: readonly Movement[];
  readonly journalKey: string;
  readonly reason: CorrectionReason;
  readonly missingConcepts?: readonly MovementType[];
  readonly counterpartJournalKey?: string;
}): ErpCorrection {
  const { movements, journalKey, reason } = input;
  if (movements.length === 0) {
    throw new ConfigurationError('Cannot build a correction for zero movements', {});
  }

  const anchor = movements[0]!;
  const lines = movements.map<CorrectionLine>((movement) => ({
    concept: movement.type,
    amount: movement.amount,
    label: movement.description,
    movementId: movement.id,
  }));

  return {
    ref: idempotencyKeyFor(anchor.id),
    journalKey,
    date: anchor.valueDate,
    reason,
    missingConcepts: input.missingConcepts ?? [],
    ...(input.counterpartJournalKey
      ? { counterpartJournalKey: input.counterpartJournalKey }
      : {}),
    lines,
    // Signed sum: charges add, deductions subtract. The result is what the
    // account should have received.
    netToAccount: Money.sum(movements.map((movement) => movement.amount)),
  };
}

/**
 * True when the correction is only money moving between accounts.
 *
 * No hay venta ni deducciones que explicar: la identidad que hace cuadrar un
 * asiento de Wompi no aplica, y el asiento son dos líneas — de dónde salió y
 * a dónde entró.
 */
export function isTransferOnly(correction: ErpCorrection): boolean {
  return correction.lines.every(
    (line) => line.concept === 'TRANSFER_IN' || line.concept === 'TRANSFER_OUT',
  );
}

/** Total of one concept across the correction, as a positive magnitude. */
export function amountOfConcept(correction: ErpCorrection, concept: MovementType): Money {
  return signedAmountOfConcept(correction, concept).abs();
}

/**
 * Lo mismo, conservando el signo.
 *
 * Hace falta porque un concepto puede ir para los dos lados: una comisión que
 * el banco cobra sale de la cuenta, y el reverso de esa misma comisión vuelve.
 * Tomar el valor absoluto y suponer el lado convertía un reverso en un asiento
 * con las dos líneas al débito.
 */
export function signedAmountOfConcept(
  correction: ErpCorrection,
  concept: MovementType,
): Money {
  return Money.sum(
    correction.lines.filter((line) => line.concept === concept).map((line) => line.amount),
  );
}

/** Every concept the correction touches, in the order it first appears. */
export function conceptsOf(correction: ErpCorrection): MovementType[] {
  return [...new Set(correction.lines.map((line) => line.concept))];
}
