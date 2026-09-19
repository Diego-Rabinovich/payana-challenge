import type { Temporal } from '@js-temporal/polyfill';
import { Money } from './money.js';

/**
 * A journal entry as the ERP holds it, normalised out of Odoo's shape.
 *
 * The ERP keeps double entry; this ledger does not. So a line arriving here
 * has already been collapsed to one signed amount — debit positive, credit
 * negative — by the adapter that read it. Nothing downstream has to know the
 * convention, and an ERP that used a different one would still land here
 * unchanged. See ADR-0006.
 */

export interface ErpLine {
  readonly id: string;
  readonly accountCode: string;
  readonly accountName: string;
  /** Signed: what the line does to its account. Debit positive. */
  readonly amount: Money;
  readonly label?: string;
}

export type ErpEntryState = 'draft' | 'posted' | 'cancel';

export interface ErpEntry {
  readonly id: string;
  readonly journalId: number;
  /** Sequence name, e.g. "WMP/2026/00001". */
  readonly name: string;
  /** Free reference field. Where we write our idempotency key. */
  readonly ref?: string;
  readonly date: Temporal.PlainDate;
  readonly state: ErpEntryState;
  readonly lines: readonly ErpLine[];
}

/** Net effect on one account. Undefined when the entry does not touch it. */
export function netOnAccount(entry: ErpEntry, accountCode: string): Money | undefined {
  const lines = entry.lines.filter((line) => line.accountCode === accountCode);
  if (lines.length === 0) return undefined;
  return Money.sum(lines.map((line) => line.amount));
}

/** The account codes an entry touches, deduplicated. */
export function accountCodesOf(entry: ErpEntry): string[] {
  return [...new Set(entry.lines.map((line) => line.accountCode))];
}

/**
 * True when the signed lines cancel out, which is what "debits equal credits"
 * becomes once the sides are collapsed.
 *
 * Odoo will not post an unbalanced entry, so a false here means we misread the
 * entry rather than that the ERP is wrong — worth knowing before reporting a
 * discrepancy against it.
 */
export function isBalanced(entry: ErpEntry): boolean {
  return Money.sum(entry.lines.map((line) => line.amount)).isZero();
}

/**
 * The transaction reference an entry points at.
 *
 * Odoo entries in the Wompi journal are named `WMP/2026/00001` and carry the
 * gateway's transaction reference; it may sit in `ref` or be appended to the
 * display name. Comparison is case-insensitive because Odoo stores it
 * uppercase and Wompi returns it lowercase.
 */
export function externalReferenceOf(entry: ErpEntry): string | undefined {
  const fromRef = entry.ref?.trim();
  if (fromRef) return fromRef.toUpperCase();

  const parenthesised = /\(([^)]+)\)\s*$/.exec(entry.name);
  return parenthesised?.[1]?.trim().toUpperCase();
}
