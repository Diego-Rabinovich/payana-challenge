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
  /** What actually moved into the account: gross less every deduction. */
  readonly netToAccount: Money;
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
    lines,
    // Signed sum: charges add, deductions subtract. The result is what the
    // account should have received.
    netToAccount: Money.sum(movements.map((movement) => movement.amount)),
  };
}

/** Total of one concept across the correction, as a positive magnitude. */
export function amountOfConcept(correction: ErpCorrection, concept: MovementType): Money {
  return Money.sum(
    correction.lines
      .filter((line) => line.concept === concept)
      .map((line) => line.amount),
  ).abs();
}

/** Every concept the correction touches, in the order it first appears. */
export function conceptsOf(correction: ErpCorrection): MovementType[] {
  return [...new Set(correction.lines.map((line) => line.concept))];
}
