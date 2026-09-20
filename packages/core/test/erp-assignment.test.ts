import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { accountId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import { InMemoryErpGateway } from '../src/testing/in-memory-erp-gateway.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { erpEntry, erpLine, testAccountMap } from '../src/testing/erp-fixture.js';
import { TEST_HOLIDAYS } from '../src/testing/ruleset-fixture.js';
import { aMovement } from '../src/testing/builders.js';
import { ReconcileErp } from '../src/usecases/reconcile-erp.js';

/**
 * The 20 January case, as it actually happened.
 *
 * The bank had three movements that day and Odoo one entry of $540.836,41 for
 * the Wompi credit. The old cascade ran once per group, so the interest credit
 * of $2.530,65 reached the entry first, matched as "part of" it merely because
 * it was smaller, and the Wompi credit — identical to the cent — came out as
 * missing from the ERP. Two wrong findings from one correct fact, decided by
 * the order the groups happened to be in.
 */

const BANK = accountId('bancolombia:00000000000');
const RANGE = {
  from: Temporal.PlainDate.from('2026-01-20'),
  to: Temporal.PlainDate.from('2026-01-20'),
};

const credit = (cents: number, description: string, tag: string) =>
  aMovement({
    accountId: BANK,
    // Un id propio por movimiento: sin esto los tres caen en un mismo grupo.
    externalId: tag,
    valueDate: Temporal.PlainDate.from('2026-01-20'),
    type: description.includes('INTERESES') ? 'INTEREST' : 'TRANSFER_IN',
    amount: Money.ofCents(cents),
    description,
    source: {
      sourceId: aMovement().source.sourceId,
      rawRecordId: aMovement().source.rawRecordId,
      locator: tag,
    },
  });

describe('un dia con varios movimientos y un solo asiento', () => {
  let movements: InMemoryMovementRepository;

  beforeEach(() => {
    movements = new InMemoryMovementRepository();
  });

  const wompiEntry = () =>
    erpEntry({
      id: 'bnk4',
      journalId: 49,
      name: 'BNK8/2026/00004',
      date: '2026-01-20',
      lines: [erpLine('111001', 54_083_641, 0, 'Acreditación Wompi')],
    });

  const reconcile = async (entries: ReturnType<typeof erpEntry>[]) =>
    new ReconcileErp(
      new InMemoryErpGateway(entries),
      movements,
      testAccountMap(),
      new BusinessCalendar(TEST_HOLIDAYS),
    ).execute({ accountId: BANK, journalKey: 'bancolombia', range: RANGE });

  it('le da el asiento al movimiento que coincide al centavo, no al primero que llega', async () => {
    await movements.upsertMany([
      credit(2_530_65, 'ABONO INTERESES AHORROS', 'interes'),
      credit(54_083_641, 'PAGO DE PROV WOMPI S.A.S.', 'wompi'),
      credit(5_049_076_700, 'PAGO INTERBANC DRUO SAS', 'druo'),
    ]);

    const report = await reconcile([wompiEntry()]);
    const conAsiento = report.lines.filter((line) => line.erpEntryName === 'BNK8/2026/00004');

    expect(conAsiento).toHaveLength(1);
    expect(conAsiento[0]!.status).toBe('MATCHED');
    expect(conAsiento[0]!.ledgerAmount?.cents).toBe(54_083_641);
    expect(conAsiento[0]!.delta?.cents ?? 0).toBe(0);
  });

  it('los otros dos quedan como faltantes, que es la verdad', async () => {
    await movements.upsertMany([
      credit(2_530_65, 'ABONO INTERESES AHORROS', 'interes'),
      credit(54_083_641, 'PAGO DE PROV WOMPI S.A.S.', 'wompi'),
      credit(5_049_076_700, 'PAGO INTERBANC DRUO SAS', 'druo'),
    ]);

    const report = await reconcile([wompiEntry()]);

    expect(report.lines.filter((line) => line.status === 'MISSING_IN_ERP')).toHaveLength(2);
    // Y nada se reporta como monto distinto: emparejar $50 millones con un
    // asiento de $540 mil no seria una diferencia a investigar, seria ruido.
    expect(report.lines.filter((line) => line.status === 'AMOUNT_MISMATCH')).toHaveLength(0);
  });

  it('el orden de los movimientos no cambia el resultado', async () => {
    const orden = [
      [credit(54_083_641, 'PAGO DE PROV WOMPI S.A.S.', 'wompi'), credit(2_530_65, 'ABONO INTERESES AHORROS', 'interes')],
      [credit(2_530_65, 'ABONO INTERESES AHORROS', 'interes'), credit(54_083_641, 'PAGO DE PROV WOMPI S.A.S.', 'wompi')],
    ];

    const resultados = [];
    for (const lote of orden) {
      movements = new InMemoryMovementRepository();
      await movements.upsertMany(lote);
      const report = await reconcile([wompiEntry()]);
      resultados.push(
        report.lines.find((line) => line.erpEntryName === 'BNK8/2026/00004')?.ledgerAmount?.cents,
      );
    }

    expect(resultados[0]).toBe(resultados[1]);
    expect(resultados[0]).toBe(54_083_641);
  });

  it('agrega varios movimientos solo cuando SUMAN el asiento', async () => {
    // Dos movimientos que juntos dan exactamente el asiento.
    await movements.upsertMany([
      credit(30_000_000, 'PAGO DE PROV WOMPI S.A.S. parte 1', 'a'),
      credit(24_083_641, 'PAGO DE PROV WOMPI S.A.S. parte 2', 'b'),
    ]);

    const report = await reconcile([wompiEntry()]);
    const agregados = report.lines.filter((line) => line.matchLevel === 'AGGREGATED');

    expect(agregados).toHaveLength(2);
    expect(agregados.every((line) => line.status === 'MATCHED')).toBe(true);
  });
});

/**
 * Un borrador coincide igual que un asiento contabilizado — y no es lo mismo.
 *
 * Es exactamente lo que pasa con los asientos que crea este sistema: quedan en
 * borrador a proposito, la corrida siguiente los encuentra y la linea dice
 * MATCHED. Cierto, pero un borrador no suma en ningun balance y puede
 * borrarse, asi que el estado viaja con la linea en vez de quedarse en el
 * adapter que leyo el ERP.
 */
describe('coincidir contra un borrador', () => {
  it('reporta el estado del asiento, no solo su nombre', async () => {
    const movements = new InMemoryMovementRepository();
    await movements.upsertMany([credit(54_083_641, 'PAGO DE PROV WOMPI S.A.S.', 'wompi')]);

    const borrador = erpEntry({
      id: 'bnk4',
      journalId: 49,
      name: '(borrador sin numerar)',
      date: '2026-01-20',
      state: 'draft',
      lines: [erpLine('111001', 54_083_641, 0, 'Acreditacion Wompi')],
    });

    const report = await new ReconcileErp(
      new InMemoryErpGateway([borrador]),
      movements,
      testAccountMap(),
      new BusinessCalendar(TEST_HOLIDAYS),
    ).execute({ accountId: BANK, journalKey: 'bancolombia', range: RANGE });

    const linea = report.lines.find((line) => line.erpEntryId === 'bnk4');
    expect(linea?.status).toBe('MATCHED');
    expect(linea?.erpEntryState).toBe('draft');
  });
});
