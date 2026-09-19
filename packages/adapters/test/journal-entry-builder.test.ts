import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { AccountMap, type ErpCorrection, Money, movementId } from '@aa/core';
import {
  entryBalances,
  isMappable,
  toJournalEntry,
  totalCredits,
  totalDebits,
} from '../src/odoo/journal-entry-builder.js';

/**
 * The boundary where single entry becomes double entry.
 *
 * The domain says which movements the ERP is missing; only this translation
 * knows a debit from a credit. These tests are what stop that knowledge from
 * drifting back inside, because they are the only ones in the repository that
 * mention either word.
 */

const CHART = AccountMap.from({
  journals: {
    wompi: { id: 48, name: 'Wompi Tarjetas', mainAccount: '1110001', suspenseAccount: '1010001' },
  },
  accounts: {
    CHARGE: { code: '420500', name: 'Otras Ventas' },
    FEE: { code: '530505', name: 'Gastos Bancarios' },
    TAX: { code: '240810', name: 'IVA Descontable' },
    WITHHOLDING: { code: '236500', name: 'Retención En La Fuente' },
  },
});

const GROSS = 1_000_000;
const FEE = 33_000;
const TAX = 6_270;
const WITHHOLDING = 15_000;
const NET = GROSS - FEE - TAX - WITHHOLDING;

function correction(overrides: Partial<ErpCorrection> = {}): ErpCorrection {
  return {
    ref: 'mov:mov_0123456789abcdef',
    journalKey: 'wompi',
    date: Temporal.PlainDate.from('2026-04-14'),
    reason: 'MISSING_ENTRY',
    missingConcepts: [],
    lines: [
      { concept: 'CHARGE', amount: Money.ofCents(GROSS), label: 'Venta' },
      { concept: 'FEE', amount: Money.ofCents(-FEE), label: 'Comisión' },
      { concept: 'TAX', amount: Money.ofCents(-TAX), label: 'IVA' },
      { concept: 'WITHHOLDING', amount: Money.ofCents(-WITHHOLDING), label: 'Retención' },
    ],
    netToAccount: Money.ofCents(NET),
    ...overrides,
  };
}

describe('toJournalEntry', () => {
  it('balances, which is the only thing Odoo will not negotiate', () => {
    const entry = toJournalEntry(correction(), CHART);

    expect(entryBalances(entry)).toBe(true);
    expect(totalDebits(entry).cents).toBe(GROSS);
    expect(totalCredits(entry).cents).toBe(GROSS);
  });

  it('uses the five accounts of the brief, and puts the sale on the credit side', () => {
    const entry = toJournalEntry(correction(), CHART);

    expect(entry.lines.map((line) => line.accountCode).sort()).toEqual([
      '1110001',
      '236500',
      '240810',
      '420500',
      '530505',
    ]);

    const sale = entry.lines.find((line) => line.accountCode === '420500');
    expect(sale?.credit.cents).toBe(GROSS);
    expect(sale?.debit.isZero()).toBe(true);

    const bank = entry.lines.find((line) => line.accountCode === '1110001');
    expect(bank?.debit.cents).toBe(NET);
  });

  it('carries the idempotency reference through untouched', () => {
    const entry = toJournalEntry(correction(), CHART);

    expect(entry.ref).toBe('mov:mov_0123456789abcdef');
    expect(entry.journalId).toBe(48);
    expect(entry.date).toBe('2026-04-14');
  });

  it('omits a deduction the correction does not carry', () => {
    const entry = toJournalEntry(
      correction({
        lines: [
          { concept: 'CHARGE', amount: Money.ofCents(GROSS), label: 'Venta' },
          { concept: 'FEE', amount: Money.ofCents(-FEE), label: 'Comisión' },
        ],
        netToAccount: Money.ofCents(GROSS - FEE),
      }),
      CHART,
    );

    expect(entry.lines.map((line) => line.accountCode)).not.toContain('240810');
    expect(entryBalances(entry)).toBe(true);
  });

  it('refuses a journal the chart does not know', () => {
    expect(() => toJournalEntry(correction({ journalKey: 'nope' }), CHART)).toThrow(
      /Unknown journal/,
    );
  });

  it('reports an unmappable correction rather than inventing an account', () => {
    const unmappable = correction({
      lines: [
        { concept: 'CHARGE', amount: Money.ofCents(GROSS), label: 'Venta' },
        { concept: 'INTEREST', amount: Money.ofCents(-1_000), label: 'Intereses' },
      ],
    });

    expect(isMappable(unmappable, CHART)).toBe(false);
    expect(isMappable(correction(), CHART)).toBe(true);
  });

  it('keeps the movement ids the correction carried, so a line is traceable', () => {
    const id = movementId('mov_0123456789abcdef');
    const traced = correction({
      lines: [{ concept: 'CHARGE', amount: Money.ofCents(GROSS), label: 'Venta', movementId: id }],
      netToAccount: Money.ofCents(GROSS),
    });

    expect(traced.lines[0]?.movementId).toBe(id);
    expect(entryBalances(toJournalEntry(traced, CHART))).toBe(true);
  });
});
