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

/**
 * Un traspaso entre dos libros nuestros.
 *
 * No hay venta ni deducciones: la identidad que hace cuadrar un asiento de
 * Wompi no aplica acá. Mientras el constructor asumió esa forma para todo, un
 * crédito del banco salía con una sola línea y no cuadraba.
 */
describe('toJournalEntry, cuando la corrección es un traspaso', () => {
  const DOS_LIBROS = AccountMap.from({
    journals: {
      wompi: { id: 48, name: 'Wompi Tarjetas', mainAccount: '1110001' },
      bancolombia: { id: 49, name: 'Bancolombia', mainAccount: '111001' },
    },
    accounts: {
      TRANSFER_IN: { code: '111001', name: 'Banco' },
      TRANSFER_OUT: { code: '111001', name: 'Banco' },
    },
  });

  const ENTRA = 36_539_335;

  const traspaso = (cents: number): ErpCorrection => ({
    ref: 'mov:mov_3fd218c4ab77756b',
    journalKey: 'bancolombia',
    counterpartJournalKey: 'wompi',
    date: Temporal.PlainDate.from('2026-01-15'),
    reason: 'MISSING_ENTRY',
    missingConcepts: [],
    lines: [
      {
        concept: cents > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT',
        amount: Money.ofCents(cents),
        label: 'PAGO DE PROV WOMPI S.A.S.',
      },
    ],
    netToAccount: Money.ofCents(cents),
  });

  it('lo arma como los que ya tiene ese diario: al banco débito, a Wompi crédito', () => {
    const entry = toJournalEntry(traspaso(ENTRA), DOS_LIBROS);

    expect(entryBalances(entry)).toBe(true);
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toMatchObject({ accountCode: '111001' });
    expect(entry.lines[0]!.debit.cents).toBe(ENTRA);
    expect(entry.lines[1]).toMatchObject({ accountCode: '1110001' });
    expect(entry.lines[1]!.credit.cents).toBe(ENTRA);
  });

  it('si la plata sale, los lados se dan vuelta', () => {
    const entry = toJournalEntry(traspaso(-ENTRA), DOS_LIBROS);

    expect(entryBalances(entry)).toBe(true);
    expect(entry.lines[0]!.credit.cents).toBe(ENTRA);
    expect(entry.lines[1]!.debit.cents).toBe(ENTRA);
  });

  it('sin el otro libro no arma medio asiento: no arma ninguno', () => {
    const { counterpartJournalKey: _, ...huerfano } = traspaso(ENTRA);
    const entry = toJournalEntry(huerfano, DOS_LIBROS);

    expect(entry.lines).toHaveLength(0);
  });
});

/**
 * Un cobro del banco: plata que sale, no que entra.
 *
 * El constructor daba por hecho que el neto siempre entra y lo ponía al
 * débito, así que un cobro salía como un débito de −$270 contra otro de $270.
 * Los dos suman cero, el control de cuadratura lo dejaba pasar, y lo que se
 * hubiera escrito no era un asiento.
 */
describe('toJournalEntry, cuando la plata sale de la cuenta', () => {
  const COBRO = 27_000;

  const cobro: ErpCorrection = {
    ref: 'mov:mov_7ac1f0de4b2299a3',
    journalKey: 'wompi',
    date: Temporal.PlainDate.from('2026-01-15'),
    reason: 'MISSING_ENTRY',
    missingConcepts: [],
    lines: [
      { concept: 'FEE', amount: Money.ofCents(-COBRO), label: 'SERVICIO E-MAILS ENVIADOS' },
    ],
    netToAccount: Money.ofCents(-COBRO),
  };

  it('lo pone al crédito de la cuenta, no como un débito negativo', () => {
    const entry = toJournalEntry(cobro, CHART);

    expect(entry.lines[0]).toMatchObject({ accountCode: '1110001' });
    expect(entry.lines[0]!.credit.cents).toBe(COBRO);
    expect(entry.lines[0]!.debit.cents).toBe(0);
    expect(entry.lines[1]).toMatchObject({ accountCode: '530505' });
    expect(entry.lines[1]!.debit.cents).toBe(COBRO);
    expect(entryBalances(entry)).toBe(true);
  });

  it('un importe negativo no cuadra aunque los totales den cero', () => {
    const torcido = {
      ref: 'x',
      journalId: 48,
      date: '2026-01-15',
      lines: [
        {
          accountCode: '1110001',
          accountName: 'Wompi',
          debit: Money.ofCents(-COBRO),
          credit: Money.zero(),
          label: 'neto',
        },
        {
          accountCode: '530505',
          accountName: 'Gastos',
          debit: Money.ofCents(COBRO),
          credit: Money.zero(),
          label: 'comisión',
        },
      ],
    };

    expect(totalDebits(torcido).cents).toBe(totalCredits(torcido).cents);
    expect(entryBalances(torcido)).toBe(false);
  });
});

/**
 * El banco cobra una cuota de manejo y después la reversa.
 *
 * Es el mismo concepto que un cobro, con el signo al revés. Mientras el
 * constructor tomó el valor absoluto y supuso el lado, el reverso salía con
 * las dos líneas al débito: $5.853,21 contra $5.853,21, y el asiento no
 * cuadraba.
 */
describe('toJournalEntry, cuando el banco reversa un cobro', () => {
  const REVERSO = 585_321;

  const reverso: ErpCorrection = {
    ref: 'mov:mov_51ba9c3de07f4412',
    journalKey: 'wompi',
    date: Temporal.PlainDate.from('2026-02-27'),
    reason: 'MISSING_ENTRY',
    missingConcepts: [],
    lines: [
      { concept: 'FEE', amount: Money.ofCents(REVERSO), label: 'REV CUOTA MANEJO TARJETA PREPA' },
    ],
    netToAccount: Money.ofCents(REVERSO),
  };

  it('devuelve la plata a la cuenta y acredita el gasto', () => {
    const entry = toJournalEntry(reverso, CHART);

    expect(entry.lines[0]!.debit.cents).toBe(REVERSO);
    expect(entry.lines[1]).toMatchObject({ accountCode: '530505' });
    expect(entry.lines[1]!.credit.cents).toBe(REVERSO);
    expect(entry.lines[1]!.debit.cents).toBe(0);
    expect(entryBalances(entry)).toBe(true);
  });
});

/**
 * Lo que Wompi retuvo, en los dos asientos que lo usan: las líneas que le faltan
 * a un asiento de venta que ya existe, y la venta que falta propuesta completa.
 */
describe('toJournalEntry, con las deducciones de Wompi', () => {
  const FEE = 740_000;
  const TAX = 140_600;
  const WITHHOLDING = 476_323;
  const RETAINED = FEE + TAX + WITHHOLDING;

  it('el complemento lleva las tres cuentas contra la de Wompi, y cuadra', () => {
    const entry = toJournalEntry(
      correction({
        ref: 'ded:mov_0123456789abcdef',
        reason: 'INCOMPLETE_ENTRY',
        lines: [
          { concept: 'FEE', amount: Money.ofCents(-FEE), label: 'Comisión' },
          { concept: 'TAX', amount: Money.ofCents(-TAX), label: 'IVA' },
          { concept: 'WITHHOLDING', amount: Money.ofCents(-WITHHOLDING), label: 'Retención' },
        ],
        netToAccount: Money.ofCents(-RETAINED),
        mainLabel: 'Retenido por Wompi',
        readOnly: true,
      }),
      CHART,
    );

    expect(entryBalances(entry)).toBe(true);
    expect(entry.lines.map((line) => line.accountCode).sort()).toEqual(
      ['1110001', '236500', '240810', '530505'],
    );
    const wompi = entry.lines.find((line) => line.accountCode === '1110001')!;
    expect(wompi.credit.cents).toBe(RETAINED);
    expect(wompi.label).toBe('Retenido por Wompi');
  });

  it('la venta completa son cinco líneas: neto, tres deducciones y el bruto', () => {
    const entry = toJournalEntry(correction(), CHART);

    expect(entryBalances(entry)).toBe(true);
    expect(entry.lines).toHaveLength(5);
    expect(entry.lines.find((line) => line.accountCode === '420500')!.credit.cents).toBe(GROSS);
    expect(entry.lines.find((line) => line.accountCode === '1110001')!.debit.cents).toBe(NET);
  });
});
