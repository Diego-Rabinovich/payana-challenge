import type { Temporal } from '@js-temporal/polyfill';
import type { Evidence } from './evidence.js';
import type { MovementId, RunId } from './ids.js';
import type { Money } from './money.js';
import type { Movement, MovementType } from './movement.js';
import type { ErpCorrection } from './erp-correction.js';
import type { ErpEntryState } from './erp-entry.js';

/**
 * Comparing a ledger against its formal book, line by line.
 *
 * The hard part is not the algorithm, it is that the granularities differ: our
 * ledger holds one movement per concept, the ERP holds whatever it holds. A
 * naive 1:1 comparison would report that everything is wrong — noise that
 * buries the real discrepancies. So every reported line says which criterion
 * resolved it, because an aggregated match is weaker evidence than a match by
 * reference. See ADR-0006.
 */

/** Which rung of the cascade produced the result. */
export type ErpMatchLevel = 'REF' | 'EXACT' | 'AGGREGATED' | 'APPROXIMATE' | 'NONE';

export type ErpLineStatus =
  | 'MATCHED'
  /** The entry exists and the sale agrees, but expected lines are absent. */
  | 'INCOMPLETE_ENTRY'
  | 'AMOUNT_MISMATCH'
  | 'DATE_SHIFT'
  | 'MISSING_IN_ERP'
  | 'MISSING_IN_LEDGER'
  | 'DUPLICATE_IN_ERP';

/**
 * The unit of comparison on our side.
 *
 * A Wompi sale is four movements sharing one external reference, and the ERP
 * records it as one entry; a bank statement row is a movement on its own.
 * Grouping by external reference covers both without special cases.
 */
export interface LedgerGroup {
  readonly key: string;
  readonly movements: readonly Movement[];
  readonly date: Temporal.PlainDate;
  /** Types present in the group, for spotting what an entry left out. */
  readonly concepts: readonly MovementType[];
}

export interface ErpReconciliationLine {
  readonly status: ErpLineStatus;
  readonly matchLevel: ErpMatchLevel;
  readonly ledgerMovementIds: readonly MovementId[];
  readonly erpEntryId?: string;
  readonly erpEntryName?: string;
  /**
   * En qué estado está el asiento contra el que coincidió.
   *
   * Un borrador no está en los libros todavía: puede cambiar, puede borrarse,
   * y no suma en ningún balance. Que la línea diga MATCHED contra un borrador
   * es cierto y engañoso al mismo tiempo, así que el estado viaja con ella en
   * lugar de quedarse en el adapter que leyó Odoo.
   */
  readonly erpEntryState?: ErpEntryState;
  /**
   * De dónde salió la plata, tal como lo dice el documento.
   *
   * Sin esto la tabla es una lista de fechas y montos: nadie puede ver de un
   * vistazo que una fila es de Wompi, otra de intereses del banco y otra de
   * un pagador que no tiene nada que ver con esta conciliación.
   */
  readonly descriptor?: string;
  readonly counterparty?: string;
  readonly date: Temporal.PlainDate;
  readonly ledgerAmount?: Money;
  readonly erpAmount?: Money;
  readonly delta?: Money;
  readonly evidence: readonly Evidence[];
  /** What would fix it, in single-entry terms. Present on every discrepancy. */
  readonly correction?: ErpCorrection;
}

export interface ErpReconciliationReport {
  readonly runId?: RunId;
  readonly journalId: number;
  readonly journalName: string;
  readonly lines: readonly ErpReconciliationLine[];
  readonly totals: {
    readonly ledgerGroups: number;
    readonly erpEntries: number;
    readonly byStatus: Readonly<Partial<Record<ErpLineStatus, number>>>;
    readonly ledgerTotal: Money;
    readonly erpTotal: Money;
    readonly unexplained: Money;
  };
}

/**
 * Groups a ledger for comparison: by external reference where the source
 * provides one, otherwise one group per movement.
 */
export function groupForComparison(movements: readonly Movement[]): LedgerGroup[] {
  const groups = new Map<string, Movement[]>();

  for (const movement of movements) {
    const key = movement.externalId ?? movement.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(movement);
    else groups.set(key, [movement]);
  }

  return [...groups.entries()]
    .map(([key, grouped]) => ({
      key,
      movements: grouped,
      date: earliestDate(grouped),
      concepts: [...new Set(grouped.map((movement) => movement.type))],
    }))
    .sort((a, b) => (a.date.toString() < b.date.toString() ? -1 : a.key < b.key ? -1 : 1));
}

function earliestDate(movements: readonly Movement[]): Temporal.PlainDate {
  return movements.reduce(
    (earliest, movement) =>
      movement.valueDate.toString() < earliest.toString() ? movement.valueDate : earliest,
    movements[0]!.valueDate,
  );
}
