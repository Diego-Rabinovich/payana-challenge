import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { amountOfConcept, conceptsOf } from '../src/domain/erp-correction.js';
import { accountId } from '../src/domain/ids.js';
import type { MatchResult } from '../src/domain/match-result.js';
import { Money } from '../src/domain/money.js';
import { InMemoryErpGateway } from '../src/testing/in-memory-erp-gateway.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { erpEntry, erpLine, testAccountMap } from '../src/testing/erp-fixture.js';
import { TEST_HOLIDAYS } from '../src/testing/ruleset-fixture.js';
import { aMovement } from '../src/testing/builders.js';
import { ReconcileErp } from '../src/usecases/reconcile-erp.js';

/**
 * A las ventas de Wompi les faltan sus deducciones.
 *
 * Wompi informa sólo el bruto, así que el ledger tiene un `CHARGE` por venta y
 * el asiento de Odoo, dos líneas al bruto. Coinciden — y nadie nota que la
 * comisión, su IVA y la retención no están en ningún lado. La fase 2 las deriva
 * por liquidación; la fase 3 las reparte entre las ventas del lote y:
 *
 *   - al asiento conciliado le marca las tres líneas que le faltan, sólo para
 *     mostrar;
 *   - al que falta se lo propone completo, con las cinco, para crear.
 */

const WOMPI = accountId('wompi:AA');
const RANGE = {
  from: Temporal.PlainDate.from('2026-04-01'),
  to: Temporal.PlainDate.from('2026-04-30'),
};

const A = { ref: 'REF-A', gross: 31_754_900 };
const B = { ref: 'REF-B', gross: 10_000_000 };
const BATCH = { fee: 1_000_001, tax: 190_000, withholding: 626_323 };

const charge = (sale: typeof A) =>
  aMovement({
    accountId: WOMPI,
    type: 'CHARGE',
    externalId: sale.ref,
    amount: Money.ofCents(sale.gross),
    valueDate: Temporal.PlainDate.from('2026-04-24'),
    description: 'Pago',
    source: {
      sourceId: aMovement().source.sourceId,
      rawRecordId: aMovement().source.rawRecordId,
      locator: sale.ref,
    },
  });

async function reconcile(withSettlements: boolean, entryGross = A.gross) {
  const [a, b] = [charge(A), charge(B)];
  const movements = new InMemoryMovementRepository();
  await movements.upsertMany([a, b]);

  // El asiento de A existe con dos líneas al bruto; el de B no existe.
  const entryA = erpEntry({
    id: 'wmp-a',
    name: 'WMP/2026/00001',
    date: '2026-04-24',
    ref: A.ref,
    lines: [erpLine('1110001', entryGross, 0, 'Wompi'), erpLine('420500', 0, entryGross, 'Otras Ventas')],
  });

  // Lo que la fase 2 dejó para la liquidación: sólo lo que esta fase lee.
  const settlement = {
    left: { chargeIds: [a.id, b.id] },
    derivedDeductions: {
      fee: Money.ofCents(BATCH.fee),
      tax: Money.ofCents(BATCH.tax),
      withholding: Money.ofCents(BATCH.withholding),
      total: Money.ofCents(BATCH.fee + BATCH.tax + BATCH.withholding),
      impliedRate: 0.043,
      consistent: true,
    },
  } as unknown as MatchResult;

  const report = await new ReconcileErp(
    new InMemoryErpGateway([entryA]),
    movements,
    testAccountMap(),
    new BusinessCalendar(TEST_HOLIDAYS),
  ).execute({
    accountId: WOMPI,
    journalKey: 'wompi',
    range: RANGE,
    ...(withSettlements ? { settlements: [settlement] } : {}),
  });

  const lineOf = (movementId: string) =>
    report.lines.find((line) => line.ledgerMovementIds.includes(movementId as never))!;
  return { a: lineOf(a.id), b: lineOf(b.id) };
}

describe('las deducciones que le faltan a cada venta de Wompi', () => {
  it('marca incompleto al asiento que sólo tiene el bruto, con las tres líneas que faltan', async () => {
    const { a } = await reconcile(true);

    expect(a.status).toBe('INCOMPLETE_ENTRY');
    expect(conceptsOf(a.correction!)).toEqual(['FEE', 'TAX', 'WITHHOLDING']);
    expect(a.evidence.map((item) => item.code)).toContain('DEDUCTIONS_DERIVED');
  });

  it('esas líneas son sólo para mostrar: no se pueden escribir', async () => {
    const { a } = await reconcile(true);

    expect(a.correction!.readOnly).toBe(true);
    // Ni siquiera la referencia es de las que el guard de escritura acepta.
    expect(a.correction!.ref.startsWith('mov:')).toBe(false);
  });

  it('propone completo, con las cinco líneas, el asiento que falta', async () => {
    const { b } = await reconcile(true);

    expect(b.status).toBe('MISSING_IN_ERP');
    expect(b.correction!.readOnly).toBeFalsy();
    expect(b.correction!.ref.startsWith('mov:')).toBe(true);
    expect(conceptsOf(b.correction!)).toEqual(['CHARGE', 'FEE', 'TAX', 'WITHHOLDING']);

    const deductions =
      amountOfConcept(b.correction!, 'FEE').cents +
      amountOfConcept(b.correction!, 'TAX').cents +
      amountOfConcept(b.correction!, 'WITHHOLDING').cents;
    expect(b.correction!.netToAccount.cents).toBe(B.gross - deductions);
  });

  it('reparte por bruto y las partes suman exacto lo que se derivó', async () => {
    const { a, b } = await reconcile(true);

    for (const [concept, total] of [
      ['FEE', BATCH.fee],
      ['TAX', BATCH.tax],
      ['WITHHOLDING', BATCH.withholding],
    ] as const) {
      const sum =
        amountOfConcept(a.correction!, concept).cents + amountOfConcept(b.correction!, concept).cents;
      expect(sum).toBe(total);
    }
    // Y a la venta más grande le toca más.
    expect(amountOfConcept(a.correction!, 'FEE').cents).toBeGreaterThan(
      amountOfConcept(b.correction!, 'FEE').cents,
    );
  });

  it('lo juzga assessMatch, con la evidencia de siempre', async () => {
    const { a } = await reconcile(true);
    const incomplete = a.evidence.find((item) => item.code === 'INCOMPLETE_ENTRY')!;

    // Lo esperado incluye las cuentas de las deducciones, y lo observado las
    // dos que el asiento tiene: es el chequeo de completitud, no uno aparte.
    expect(incomplete.expected).toContain('530505');
    expect(incomplete.observed).toBe('1110001, 420500');
  });

  it('con monto distinto también, nombra las líneas que faltan como la causa', async () => {
    // Antes esto salía «monto distinto» y las deducciones no aparecían: el
    // chequeo vivía afuera de assessMatch y sólo corría si el par coincidía.
    const { a } = await reconcile(true, A.gross + 50_000);

    expect(a.status).toBe('INCOMPLETE_ENTRY');
    expect(a.evidence.map((item) => item.code)).toContain('AMOUNT_MISMATCH_ERP');
    expect(conceptsOf(a.correction!)).toEqual(['FEE', 'TAX', 'WITHHOLDING']);
  });

  it('sin resultados de la fase 2 no inventa nada: el asiento queda conciliado', async () => {
    const { a, b } = await reconcile(false);

    expect(a.status).toBe('MATCHED');
    expect(conceptsOf(b.correction!)).toEqual(['CHARGE']);
  });
});
