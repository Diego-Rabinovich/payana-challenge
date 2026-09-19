import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import type { ErpEntry } from '../src/domain/erp-entry.js';
import { amountOfConcept, conceptsOf } from '../src/domain/erp-correction.js';
import { accountId, runId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import type { Movement, MovementType } from '../src/domain/movement.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { InMemoryErpGateway } from '../src/testing/in-memory-erp-gateway.js';
import {
  erpEntry,
  erpLine,
  fiveLineEntry,
  testAccountMap,
  twoLineGrossEntry,
} from '../src/testing/erp-fixture.js';
import { TEST_HOLIDAYS } from '../src/testing/ruleset-fixture.js';
import { aMovement } from '../src/testing/builders.js';
import { ReconcileErp } from '../src/usecases/reconcile-erp.js';

const WOMPI = accountId('wompi:AA');
const RUN = runId('run_erp');
const RANGE = {
  from: Temporal.PlainDate.from('2026-04-01'),
  to: Temporal.PlainDate.from('2026-04-30'),
};

/** The real transaction: gross 317,549.00 → net 303,429.52. */
const SALE = { gross: 31_754_900, fee: 786_240, tax: 149_385, withholding: 476_323 };
const NET = 30_342_952;
const REFERENCE = 'TKFGJOKOQFHWVIGU71QQQ';

function saleMovements(reference = REFERENCE, date = '2026-04-24', amounts = SALE): Movement[] {
  const part = (type: MovementType, cents: number, slot: string) =>
    aMovement({
      accountId: WOMPI,
      type,
      externalId: reference,
      amount: Money.ofCents(cents),
      valueDate: Temporal.PlainDate.from(date),
      description: slot,
      source: {
        sourceId: aMovement().source.sourceId,
        rawRecordId: aMovement().source.rawRecordId,
        locator: `${reference}-${slot}`,
      },
    });

  return [
    part('CHARGE', amounts.gross, 'Pago'),
    part('FEE', -amounts.fee, 'Comisión'),
    part('TAX', -amounts.tax, 'IVA de la comisión'),
    part('WITHHOLDING', -amounts.withholding, 'Retención en la fuente'),
  ];
}

describe('ReconcileErp', () => {
  let movements: InMemoryMovementRepository;

  const reconcile = (entries: ErpEntry[]) =>
    new ReconcileErp(
      new InMemoryErpGateway(entries),
      movements,
      testAccountMap(),
      new BusinessCalendar(TEST_HOLIDAYS),
    ).execute({ accountId: WOMPI, journalKey: 'wompi', range: RANGE, runId: RUN });

  beforeEach(() => {
    movements = new InMemoryMovementRepository();
  });

  it('matches by the transaction reference the entry name carries (F03-T02)', async () => {
    await movements.upsertMany(saleMovements());

    const report = await reconcile([
      fiveLineEntry({
        id: '1',
        name: `WMP/2026/00001 (${REFERENCE})`,
        date: '2026-04-24',
        grossCents: SALE.gross,
        feeCents: SALE.fee,
        taxCents: SALE.tax,
        withholdingCents: SALE.withholding,
      }),
    ]);

    const [line] = report.lines;
    expect(line?.status).toBe('MATCHED');
    expect(line?.matchLevel).toBe('REF');
    expect(line?.evidence[0]?.code).toBe('MATCHED_BY_REF');
  });

  it('matches the reference case-insensitively, since Odoo upper-cases it', async () => {
    await movements.upsertMany(saleMovements(REFERENCE.toLowerCase()));

    const report = await reconcile([
      fiveLineEntry({
        id: '1',
        name: `WMP/2026/00001 (${REFERENCE})`,
        date: '2026-04-24',
        grossCents: SALE.gross,
        feeCents: SALE.fee,
        taxCents: SALE.tax,
        withholdingCents: SALE.withholding,
      }),
    ]);

    expect(report.lines[0]?.status).toBe('MATCHED');
  });

  describe('an entry that records the gross with no breakdown (F03-T04)', () => {
    // The shape observed in the real journal: two lines, bank debited at the
    // gross amount, nothing for fee, VAT or withholding.
    const twoLine = () =>
      twoLineGrossEntry({
        id: '1',
        name: `WMP/2026/00001 (${REFERENCE})`,
        date: '2026-04-24',
        grossCents: SALE.gross,
      });

    it('is reported as incomplete, naming the concepts it omits', async () => {
      await movements.upsertMany(saleMovements());

      const [line] = (await reconcile([twoLine()])).lines;

      expect(line?.status).toBe('INCOMPLETE_ENTRY');
      expect(line?.evidence.map((e) => e.code)).toContain('INCOMPLETE_ENTRY');
      expect(line?.evidence.find((e) => e.code === 'INCOMPLETE_ENTRY')?.detail).toContain('FEE');
    });

    it('also shows the bank line overstated by exactly the deductions', async () => {
      await movements.upsertMany(saleMovements());

      const [line] = (await reconcile([twoLine()])).lines;

      // 317,549.00 recorded where 303,429.52 actually landed.
      expect(line?.delta?.cents).toBe(SALE.gross - NET);
      expect(line?.evidence.map((e) => e.code)).toContain('AMOUNT_MISMATCH_ERP');
    });

    it('reports the missing lines as the cause, not the amount as the symptom', async () => {
      await movements.upsertMany(saleMovements());

      const [line] = (await reconcile([twoLine()])).lines;

      // Both facts are reported, but the status names the one to act on.
      expect(line?.status).toBe('INCOMPLETE_ENTRY');
    });

    it('carries the correction in single-entry terms, every concept accounted for', async () => {
      await movements.upsertMany(saleMovements());

      const [line] = (await reconcile([twoLine()])).lines;
      const correction = line?.correction;

      expect(correction).toBeDefined();
      // No debits, no credits: the domain says what is missing, not how an
      // ERP would post it.
      expect(conceptsOf(correction!).sort()).toEqual(['CHARGE', 'FEE', 'TAX', 'WITHHOLDING']);
      expect(amountOfConcept(correction!, 'CHARGE').cents).toBe(SALE.gross);

      const deducted =
        amountOfConcept(correction!, 'FEE').cents +
        amountOfConcept(correction!, 'TAX').cents +
        amountOfConcept(correction!, 'WITHHOLDING').cents;
      expect(correction!.netToAccount.cents).toBe(SALE.gross - deducted);
    });
  });

  it('reports a transaction the ERP never recorded, with the entry that would fix it', async () => {
    await movements.upsertMany(saleMovements());

    const [line] = (await reconcile([])).lines;

    expect(line?.status).toBe('MISSING_IN_ERP');
    expect(line?.matchLevel).toBe('NONE');
    expect(line?.correction?.reason).toBe('MISSING_ENTRY');
    expect(line?.correction?.journalKey).toBe('wompi');
  });

  it('proposes an idempotent reference, so a rerun cannot duplicate (F03-T12)', async () => {
    await movements.upsertMany(saleMovements());
    const gateway = new InMemoryErpGateway([]);

    const report = await new ReconcileErp(
      gateway,
      movements,
      testAccountMap(),
      new BusinessCalendar(TEST_HOLIDAYS),
    ).execute({ accountId: WOMPI, journalKey: 'wompi', range: RANGE });

    const correction = report.lines[0]!.correction!;
    expect(correction.ref).toMatch(/^mov:mov_[0-9a-f]{16}$/);

    const first = await gateway.createDraftEntry(correction);
    const second = await gateway.createDraftEntry(correction);
    expect(second).toBe(first);
    expect(gateway.created).toHaveLength(1);
  });

  it('reports an entry with nothing behind it (F03-T06)', async () => {
    const report = await reconcile([
      twoLineGrossEntry({ id: '9', name: 'WMP/2026/00099 (GHOST)', date: '2026-04-10', grossCents: 5_000 }),
    ]);

    expect(report.lines[0]?.status).toBe('MISSING_IN_LEDGER');
    expect(report.lines[0]?.erpEntryName).toBe('WMP/2026/00099 (GHOST)');
  });

  it('flags two entries carrying the same reference (F03-T08)', async () => {
    await movements.upsertMany(saleMovements());

    const duplicate = (id: string) =>
      fiveLineEntry({
        id,
        name: `WMP/2026/0000${id} (${REFERENCE})`,
        date: '2026-04-24',
        grossCents: SALE.gross,
        feeCents: SALE.fee,
        taxCents: SALE.tax,
        withholdingCents: SALE.withholding,
      });

    const report = await reconcile([duplicate('1'), duplicate('2')]);

    expect(report.lines.some((line) => line.status === 'DUPLICATE_IN_ERP')).toBe(true);
  });

  it('calls a same-amount entry a date shift rather than missing (F03-T07)', async () => {
    await movements.upsertMany(saleMovements(REFERENCE, '2026-04-22'));

    const report = await reconcile([
      fiveLineEntry({
        id: '1',
        // No reference, so it cannot match at level 1.
        name: 'WMP/2026/00001',
        date: '2026-04-24',
        grossCents: SALE.gross,
        feeCents: SALE.fee,
        taxCents: SALE.tax,
        withholdingCents: SALE.withholding,
      }),
    ]);

    const line = report.lines.find((l) => l.matchLevel === 'APPROXIMATE');
    expect(line?.status).toBe('DATE_SHIFT');
  });

  it('never claims one entry for two ledger groups', async () => {
    await movements.upsertMany([
      ...saleMovements('REF-A', '2026-04-24'),
      ...saleMovements('REF-B', '2026-04-24'),
    ]);

    const report = await reconcile([
      fiveLineEntry({
        id: '1',
        name: 'WMP/2026/00001 (REF-A)',
        date: '2026-04-24',
        grossCents: SALE.gross,
        feeCents: SALE.fee,
        taxCents: SALE.tax,
        withholdingCents: SALE.withholding,
      }),
    ]);

    const claimed = report.lines.filter((line) => line.erpEntryId === '1');
    expect(claimed).toHaveLength(1);
    expect(report.lines.filter((l) => l.status === 'MISSING_IN_ERP')).toHaveLength(1);
  });

  it('proposes nothing for a concept the chart does not cover (F03-T10)', async () => {
    const bank = accountId('bancolombia:00000000000');
    await movements.upsertMany([
      aMovement({
        accountId: bank,
        type: 'INTEREST',
        amount: Money.ofCents(215_447),
        valueDate: Temporal.PlainDate.from('2026-04-02'),
        description: 'ABONO INTERESES AHORROS',
        source: {
          sourceId: aMovement().source.sourceId,
          rawRecordId: aMovement().source.rawRecordId,
          locator: 'interest',
        },
      }),
    ]);

    const report = await new ReconcileErp(
      new InMemoryErpGateway([]),
      movements,
      testAccountMap(),
      new BusinessCalendar(TEST_HOLIDAYS),
    ).execute({ accountId: bank, journalKey: 'bancolombia', range: RANGE });

    const [line] = report.lines;
    expect(line?.status).toBe('MISSING_IN_ERP');
    expect(line?.evidence.map((e) => e.code)).toContain('NO_ACCOUNT_MAPPING');
    // Inventing an account would be worse than saying none exists.
    expect(line?.correction).toBeUndefined();
  });

  it('counts every element of both sides, losing none in between (F03-T16)', async () => {
    await movements.upsertMany(saleMovements());

    const report = await reconcile([
      erpEntry({
        id: '9',
        name: 'WMP/2026/00099',
        date: '2026-04-10',
        lines: [erpLine('1110001', 5_000, 0), erpLine('420500', 0, 5_000)],
      }),
    ]);

    expect(report.totals.ledgerGroups).toBe(1);
    expect(report.totals.erpEntries).toBe(1);
    expect(report.lines).toHaveLength(2);
    expect(report.lines.every((line) => line.evidence.length > 0)).toBe(true);
  });
});
