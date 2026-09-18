import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { type AccountId, accountId, runId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import type { Movement, MovementType } from '../src/domain/movement.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { TEST_HOLIDAYS, testRuleSet } from '../src/testing/ruleset-fixture.js';
import { aMovement } from '../src/testing/builders.js';
import { T1DailyBatchRule } from '../src/rules/t1-daily-batch.rule.js';
import { ReconcileFlow } from '../src/usecases/reconcile-flow.js';

const WOMPI = accountId('wompi:AA');
const BANK = accountId('bancolombia:00000000000');
const RUN = runId('run_test');
const RANGE = {
  from: Temporal.PlainDate.from('2025-12-01'),
  to: Temporal.PlainDate.from('2026-01-31'),
};

/** Real figures: gross 317,549.00 → net 303,429.52 after the three deductions. */
const SALE = { gross: 31_754_900, fee: 786_240, tax: 149_385, withholding: 476_323 };
const NET = 30_342_952;

function saleOn(date: string, amounts = SALE, tag = 'a'): Movement[] {
  const part = (type: MovementType, cents: number, slot: string) =>
    aMovement({
      accountId: WOMPI,
      type,
      externalId: `${date}-${tag}`,
      amount: Money.ofCents(cents),
      valueDate: Temporal.PlainDate.from(date),
      description: 'Pago aprobado',
      source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: `${date}-${tag}-${slot}` },
    });

  return [
    part('CHARGE', amounts.gross, 'charge'),
    part('FEE', -amounts.fee, 'fee'),
    part('TAX', -amounts.tax, 'tax'),
    part('WITHHOLDING', -amounts.withholding, 'withholding'),
  ];
}

function bankCredit(date: string, cents: number, counterparty: string, tag = 'c'): Movement {
  return aMovement({
    accountId: BANK,
    type: 'TRANSFER_IN',
    amount: Money.ofCents(cents),
    valueDate: Temporal.PlainDate.from(date),
    counterparty,
    description: `PAGO DE PROV ${counterparty}`,
    source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: `${date}-${cents}-${tag}` },
  });
}

describe('ReconcileFlow', () => {
  let movements: InMemoryMovementRepository;
  let flow: ReconcileFlow;

  const run = (accounts: { gateway?: AccountId } = {}) =>
    flow.execute({
      gatewayAccountId: accounts.gateway ?? WOMPI,
      bankAccountId: BANK,
      channel: 'wompi',
      range: RANGE,
      runId: RUN,
    });

  beforeEach(() => {
    movements = new InMemoryMovementRepository();
    flow = new ReconcileFlow(
      movements,
      new BusinessCalendar(TEST_HOLIDAYS),
      testRuleSet(),
      [new T1DailyBatchRule()],
    );
  });

  it('matches the 31 December batch to the 2 January credit (F02-T01, F02-T04)', async () => {
    // The real shape of the January statement: nothing on the 1st because it
    // is a holiday, first Wompi credit on Friday the 2nd.
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.'),
    ]);

    const report = await run();
    const [match] = report.matches;

    expect(match?.status).toBe('CONFIRMED');
    expect(match?.confidence.score).toBe(100);
    expect(match?.confidence.components.map((c) => c.code)).toEqual([
      'AMOUNT_EXACT',
      'DATE_T1_EXACT',
      'DESCRIPTOR_MATCH',
      'IDENTITY_HOLDS',
      'UNIQUE_CANDIDATE',
    ]);
  });

  it('answers all six explainability questions on every match', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.'),
    ]);

    const [match] = (await run()).matches;

    expect(match?.left.chargeIds).toHaveLength(1); // which movements
    expect(match?.rule).toEqual({ id: 'T1_DAILY_BATCH', version: 1 }); // which rule
    expect(match?.amounts.delta?.cents).toBe(0); // which adjustment
    expect(match?.window).toMatchObject({ basis: 'BUSINESS_DAYS' }); // which window
    expect(match?.confidence.band).toBe('CONFIRMED'); // how confident
    expect(match?.alternatives).toEqual([]); // what was discarded
    expect(match?.rulesetVersion).toBe('v1-test'); // and how to reproduce it
  });

  it('accepts a credit inside the rounding tolerance, at lower confidence (F02-T06)', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET - 5_000, 'WOMPI S.A.S.'),
    ]);

    const [match] = (await run()).matches;

    expect(match?.confidence.components[0]?.code).toBe('AMOUNT_WITHIN_ROUNDING');
    expect(match?.status).toBe('PROBABLE');
  });

  it('reports two equally good credits as ambiguous, never picking one (F02-T07)', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.', 'first'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.', 'second'),
    ]);

    const report = await run();
    const [match] = report.matches;

    expect(match?.status).toBe('AMBIGUOUS');
    expect(match?.alternatives).toHaveLength(1);
    expect(match?.alternatives[0]?.rejectedBecause).toBe('COMPETING_CANDIDATE');
    // The one it did not take stays visible rather than disappearing.
    expect(report.unattributed).toHaveLength(1);
  });

  it('never gives a batch a credit belonging to someone else (F02-T14)', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET, 'DRUO SAS'),
    ]);

    const report = await run();

    expect(report.matches[0]?.status).toBe('UNMATCHED');
    expect(report.matches[0]?.right).toBeNull();
    expect(report.unattributed[0]?.reason).toBe('DESCRIPTOR_FOREIGN');
  });

  it('reports a day whose money never arrived, with a reason (F02-T09)', async () => {
    await movements.upsertMany(saleOn('2025-12-31'));

    const [match] = (await run()).matches;

    expect(match?.status).toBe('UNMATCHED');
    expect(match?.confidence.components.map((c) => c.code)).toContain('DATE_OUT_OF_WINDOW');
  });

  it('creates no batch for a day with no sales (F02-T09)', async () => {
    await movements.upsertMany([bankCredit('2026-01-02', NET, 'WOMPI S.A.S.')]);

    const report = await run();

    expect(report.matches).toEqual([]);
    expect(report.unattributed).toHaveLength(1);
  });

  it('does not hand two credits of the same day to one batch (F02-T10)', async () => {
    // Two trading days, two credits. Each batch must take its own.
    await movements.upsertMany([
      ...saleOn('2025-12-31', SALE, 'a'),
      ...saleOn('2026-01-02', SALE, 'b'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.', 'first'),
      bankCredit('2026-01-05', NET, 'WOMPI S.A.S.', 'second'),
    ]);

    const report = await run();
    const claimed = report.matches.map((m) => m.right?.movementId);

    expect(new Set(claimed).size).toBe(2);
    expect(report.matches.every((m) => m.right !== null)).toBe(true);
  });

  it('leaves interest and unrelated transfers visible instead of dropping them', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.'),
      aMovement({
        accountId: BANK,
        type: 'INTEREST',
        amount: Money.ofCents(215_447),
        valueDate: Temporal.PlainDate.from('2026-01-02'),
        counterparty: 'BANCOLOMBIA',
        description: 'ABONO INTERESES AHORROS',
        source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: 'interest' },
      }),
    ]);

    const report = await run();

    expect(report.matches[0]?.status).toBe('CONFIRMED');
    expect(report.unattributed.map((u) => u.description)).toEqual(['ABONO INTERESES AHORROS']);
  });

  it('totals what was expected against what actually landed', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.'),
    ]);

    const report = await run();

    expect(report.totals.batches).toBe(1);
    expect(report.totals.expectedNet.cents).toBe(NET);
    expect(report.totals.observedNet.cents).toBe(NET);
    expect(report.totals.unexplained.isZero()).toBe(true);
    expect(report.totals.byStatus).toEqual({ CONFIRMED: 1 });
  });

  it('produces identical results on a rerun (F02-T17)', async () => {
    await movements.upsertMany([
      ...saleOn('2025-12-31', SALE, 'a'),
      ...saleOn('2026-01-05', SALE, 'b'),
      bankCredit('2026-01-02', NET, 'WOMPI S.A.S.', 'first'),
      bankCredit('2026-01-06', NET, 'WOMPI S.A.S.', 'second'),
    ]);

    const first = await run();
    const second = await run();

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
