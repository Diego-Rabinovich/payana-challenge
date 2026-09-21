import {
  type AccountMap,
  ConfigurationError,
  type ErpCorrection,
  Money,
  type MovementType,
  conceptsOf,
  isTransferOnly,
  signedAmountOfConcept,
} from '@aa/core';

/**
 * Single entry in, double entry out.
 *
 * This is the only place in the system that knows a debit from a credit. The
 * domain says which movements are missing and what net should have reached the
 * account; turning that into a balanced journal entry is Odoo's convention,
 * and conventions belong in the adapter that has to satisfy them.
 *
 * The entry balances by the identity Phase 2 also checks:
 *   gross = net + commission + VAT + withholding
 */

export interface JournalEntryLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly debit: Money;
  readonly credit: Money;
  readonly label: string;
}

export interface JournalEntryDraft {
  readonly ref: string;
  readonly journalId: number;
  readonly date: string;
  readonly lines: readonly JournalEntryLine[];
}

/** Concepts the gateway deducts, all of which land on the debit side. */
const DEDUCTIONS: readonly MovementType[] = ['FEE', 'TAX', 'WITHHOLDING'];

export function toJournalEntry(
  correction: ErpCorrection,
  accountMap: AccountMap,
): JournalEntryDraft {
  const journal = accountMap.journal(correction.journalKey);
  if (!journal) {
    throw new ConfigurationError(`Unknown journal ${correction.journalKey}`, {
      journalKey: correction.journalKey,
    });
  }

  // Un traspaso entre dos libros nuestros no tiene venta ni deducciones que
  // explicar: son dos líneas, de dónde salió y a dónde entró. Es exactamente
  // como están armados los asientos que ya tiene el diario del banco
  // (D 111001 Bank / C 1110001 Wompi Tarjetas), así que el asiento que
  // proponemos se parece a los que el contador ya reconoce.
  if (isTransferOnly(correction)) {
    return {
      ref: correction.ref,
      journalId: journal.id,
      date: correction.date.toString(),
      lines: transferLines(correction, journal, accountMap),
    };
  }

  const lines: JournalEntryLine[] = [];

  // Lo que efectivamente se movió en la cuenta. El signo elige el lado: un
  // egreso es un crédito, no un débito negativo. Un débito negativo cuadra
  // contra cualquier cosa — dos números que suman cero pasan el control de
  // cuadratura sin ser un asiento —, así que el signo se resuelve acá.
  const net = correction.netToAccount;
  if (!net.isZero()) {
    const arrives = net.cents > 0;
    lines.push({
      accountCode: journal.mainAccount,
      accountName: journal.name,
      debit: arrives ? net.abs() : Money.zero(),
      credit: arrives ? Money.zero() : net.abs(),
      label: correction.mainLabel ?? (arrives ? 'Neto acreditado' : 'Neto debitado'),
    });
  }

  // Cada deducción: un gasto, un IVA descontable o una retención. Al débito
  // cuando la plata se fue, al crédito cuando vuelve — el banco cobra una
  // cuota de manejo y después la reversa, y el reverso es la misma cuenta del
  // otro lado.
  for (const concept of DEDUCTIONS) {
    const signed = signedAmountOfConcept(correction, concept);
    if (signed.isZero()) continue;

    const account = accountMap.requireAccount(concept);
    const spent = signed.cents < 0;
    lines.push({
      accountCode: account.code,
      accountName: account.name,
      debit: spent ? signed.abs() : Money.zero(),
      credit: spent ? Money.zero() : signed.abs(),
      label: account.name,
    });
  }

  // The sale itself, credited at gross. Una devolución la debita.
  const gross = signedAmountOfConcept(correction, 'CHARGE');
  if (!gross.isZero()) {
    const account = accountMap.requireAccount('CHARGE');
    const sold = gross.cents > 0;
    lines.push({
      accountCode: account.code,
      accountName: account.name,
      debit: sold ? Money.zero() : gross.abs(),
      credit: sold ? gross.abs() : Money.zero(),
      label: account.name,
    });
  }

  return {
    ref: correction.ref,
    journalId: journal.id,
    date: correction.date.toString(),
    lines,
  };
}

/**
 * The two sides of a transfer, with the sign deciding which is debited.
 *
 * Returns nothing when the other book is unknown: one line that cannot be
 * balanced is not half an entry, it is not an entry.
 */
function transferLines(
  correction: ErpCorrection,
  journal: { readonly id: number; readonly name: string; readonly mainAccount: string },
  accountMap: AccountMap,
): JournalEntryLine[] {
  const other = correction.counterpartJournalKey
    ? accountMap.journal(correction.counterpartJournalKey)
    : undefined;
  if (!other) return [];

  const net = correction.netToAccount;
  const magnitude = net.abs();
  const arrives = net.cents > 0;

  const here: JournalEntryLine = {
    accountCode: journal.mainAccount,
    accountName: journal.name,
    debit: arrives ? magnitude : Money.zero(),
    credit: arrives ? Money.zero() : magnitude,
    label: arrives ? 'Neto acreditado' : 'Neto debitado',
  };
  const there: JournalEntryLine = {
    accountCode: other.mainAccount,
    accountName: other.name,
    debit: arrives ? Money.zero() : magnitude,
    credit: arrives ? magnitude : Money.zero(),
    label: other.name,
  };

  return [here, there];
}

/**
 * Whether the entry is one Odoo would accept.
 *
 * Not only "debits equal credits": also that no line carries a negative
 * amount. Sin esa segunda mitad, un débito de −$1.186 junto a uno de $1.186
 * suma cero y pasa, y lo que se escribiría no es un asiento.
 */
export function entryBalances(entry: JournalEntryDraft): boolean {
  const negative = entry.lines.some((line) => line.debit.cents < 0 || line.credit.cents < 0);
  return !negative && totalDebits(entry).cents === totalCredits(entry).cents;
}

export function totalDebits(entry: JournalEntryDraft): Money {
  return Money.sum(entry.lines.map((line) => line.debit));
}

export function totalCredits(entry: JournalEntryDraft): Money {
  return Money.sum(entry.lines.map((line) => line.credit));
}

/** True when the chart covers every concept the correction touches. */
export function isMappable(correction: ErpCorrection, accountMap: AccountMap): boolean {
  return conceptsOf(correction).every((concept) => accountMap.isMapped(concept));
}
