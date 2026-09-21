import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { accountId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import { RuleSet } from '../src/domain/ruleset.js';
import { InMemoryErpGateway } from '../src/testing/in-memory-erp-gateway.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { testAccountMap } from '../src/testing/erp-fixture.js';
import { TEST_HOLIDAYS, TEST_RULESET_CONFIG } from '../src/testing/ruleset-fixture.js';
import { aMovement } from '../src/testing/builders.js';
import { ReconcileErp } from '../src/usecases/reconcile-erp.js';

/**
 * Un crédito que entra al banco y no tiene asiento.
 *
 * El asiento que lo corregiría tiene dos líneas, no una: la plata entró al
 * banco porque salió de otro lado. Mientras el constructor de asientos asumió
 * la forma de una venta de Wompi — bruto al crédito, deducciones al débito —,
 * un traspaso salía con una sola línea, no cuadraba, y el botón de crearlo
 * quedaba deshabilitado sin decir por qué.
 */

const BANK = accountId('bancolombia:00000000000');
const RANGE = {
  from: Temporal.PlainDate.from('2026-01-15'),
  to: Temporal.PlainDate.from('2026-01-15'),
};

const credit = (cents: number, description: string, counterparty: string, tag: string) =>
  aMovement({
    accountId: BANK,
    externalId: tag,
    valueDate: Temporal.PlainDate.from('2026-01-15'),
    type: 'TRANSFER_IN',
    amount: Money.ofCents(cents),
    description,
    counterparty,
    source: {
      sourceId: aMovement().source.sourceId,
      rawRecordId: aMovement().source.rawRecordId,
      locator: tag,
    },
  });

const reconcile = async (movimientos: ReturnType<typeof credit>[]) => {
  const movements = new InMemoryMovementRepository();
  await movements.upsertMany(movimientos);

  return new ReconcileErp(
    new InMemoryErpGateway([]),
    movements,
    testAccountMap(),
    new BusinessCalendar(TEST_HOLIDAYS),
    undefined,
    { ruleSet: RuleSet.from(TEST_RULESET_CONFIG) },
  ).execute({ accountId: BANK, journalKey: 'bancolombia', range: RANGE });
};

describe('el asiento que corrige un traspaso', () => {
  it('sabe de qué otro libro salió la plata', async () => {
    const report = await reconcile([
      credit(36_539_335, 'PAGO DE PROV WOMPI S.A.S.', 'WOMPI S.A.S.', 'wompi'),
    ]);

    const [linea] = report.lines;
    expect(linea?.status).toBe('MISSING_IN_ERP');
    expect(linea?.correction?.counterpartJournalKey).toBe('wompi');
  });

  it('no lo propone cuando el que pagó no es una fuente que llevemos', async () => {
    // Entra al banco igual que el de Wompi, pero la otra mitad está en un
    // libro que no es nuestro. Proponer un asiento sería inventar la
    // contrapartida.
    const report = await reconcile([
      credit(5_049_076_700, 'PAGO INTERBANC DRUO SAS', 'DRUO SAS', 'druo'),
    ]);

    const [linea] = report.lines;
    expect(linea?.status).toBe('MISSING_IN_ERP');
    expect(linea?.correction).toBeUndefined();
    expect(linea?.evidence.map((item) => item.code)).toContain('NO_CONTRA_ACCOUNT');
  });
});
