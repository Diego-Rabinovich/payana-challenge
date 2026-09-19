import {
  type AccountMap,
  ConfigurationError,
  type ErpCorrection,
  Money,
  type MovementType,
  amountOfConcept,
  conceptsOf,
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

  const lines: JournalEntryLine[] = [];

  // What actually arrived in the account, debited.
  if (!correction.netToAccount.isZero()) {
    lines.push({
      accountCode: journal.mainAccount,
      accountName: journal.name,
      debit: correction.netToAccount,
      credit: Money.zero(),
      label: 'Neto acreditado',
    });
  }

  // Each deduction, debited as an expense, a tax credit or a withholding.
  for (const concept of DEDUCTIONS) {
    const amount = amountOfConcept(correction, concept);
    if (amount.isZero()) continue;

    const account = accountMap.requireAccount(concept);
    lines.push({
      accountCode: account.code,
      accountName: account.name,
      debit: amount,
      credit: Money.zero(),
      label: account.name,
    });
  }

  // The sale itself, credited at gross.
  const gross = amountOfConcept(correction, 'CHARGE');
  if (!gross.isZero()) {
    const account = accountMap.requireAccount('CHARGE');
    lines.push({
      accountCode: account.code,
      accountName: account.name,
      debit: Money.zero(),
      credit: gross,
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

export function entryBalances(entry: JournalEntryDraft): boolean {
  return totalDebits(entry).cents === totalCredits(entry).cents;
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
