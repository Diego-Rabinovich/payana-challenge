import { Temporal } from '@js-temporal/polyfill';
import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { Money } from '../src/domain/money.js';
import { ReconcileFlow } from '../src/usecases/reconcile-flow.js';
import { ScheduledSettlementRule } from '../src/rules/scheduled-settlement.rule.js';
import { SplitSettlementRule } from '../src/rules/split-settlement.rule.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { BANK_ACCOUNT, WOMPI_ACCOUNT, aMovement } from '../src/testing/builders.js';
import { TEST_HOLIDAYS, testRuleSet } from '../src/testing/ruleset-fixture.js';

/**
 * A batch that arrived as two credits.
 *
 * This used to be three findings — one unmatched batch and two unattributed
 * credits — where there is one fact. The point of the change is not that the
 * arithmetic now closes, it is that the result says how the money arrived,
 * and that arriving the wrong way costs confidence.
 */

const date = (iso: string) => Temporal.PlainDate.from(iso);

const GROSS = 10_000_000;
const FEE = 400_000;
const NET = GROSS - FEE;

describe('SplitSettlementRule', () => {
  let movements: InMemoryMovementRepository;

  beforeEach(() => {
    movements = new InMemoryMovementRepository();
  });

  const saleOn = (iso: string) => [
    aMovement({
      accountId: WOMPI_ACCOUNT,
      externalId: `sale-${iso}`,
      valueDate: date(iso),
      type: 'CHARGE',
      amount: Money.ofCents(GROSS),
    }),
    aMovement({
      accountId: WOMPI_ACCOUNT,
      externalId: `fee-${iso}`,
      valueDate: date(iso),
      type: 'FEE',
      amount: Money.ofCents(-FEE),
      description: 'Comisión',
    }),
  ];

  const credit = (iso: string, cents: number, tag: string) =>
    aMovement({
      accountId: BANK_ACCOUNT,
      externalId: `credit-${tag}`,
      valueDate: date(iso),
      type: 'TRANSFER_IN',
      amount: Money.ofCents(cents),
      description: 'PAGO DE PROV WOMPI S.A.S.',
      counterparty: 'WOMPI S.A.S.',
    });

  const run = () =>
    new ReconcileFlow(
      movements,
      new BusinessCalendar(TEST_HOLIDAYS),
      testRuleSet(),
      [new ScheduledSettlementRule(), new SplitSettlementRule()],
    ).execute({
      gatewayAccountId: WOMPI_ACCOUNT,
      bankAccountId: BANK_ACCOUNT,
      channel: 'wompi',
      range: { from: date('2026-04-13'), to: date('2026-04-14') },
    });

  it('matches a batch that arrived as two credits, naming both', async () => {
    await movements.upsertMany([
      ...saleOn('2026-04-14'),
      credit('2026-04-15', 6_000_000, 'a'),
      credit('2026-04-15', 3_600_000, 'b'),
    ]);

    const report = await run();
    const [match] = report.matches;

    expect(match?.right?.movementIds).toHaveLength(2);
    expect(match?.rule.id).toBe('SPLIT_SETTLEMENT');
    expect(match?.amounts.observedNet?.cents).toBe(NET);
    // Neither credit is also reported as nobody's.
    expect(report.unattributed).toHaveLength(0);
  });

  it('says out loud that it did not arrive the way it should have', async () => {
    await movements.upsertMany([
      ...saleOn('2026-04-14'),
      credit('2026-04-15', 6_000_000, 'a'),
      credit('2026-04-15', 3_600_000, 'b'),
    ]);

    const [match] = (await run()).matches;
    const codes = match!.confidence.components.map((item) => item.code);

    expect(codes).toContain('SETTLEMENT_SPLIT');
    expect(codes).not.toContain('SETTLEMENT_SINGLE_CREDIT');

    const split = match!.confidence.components.find((item) => item.code === 'SETTLEMENT_SPLIT');
    expect(split?.passed).toBe(false);
    expect(split?.detail).toContain('2026-04-15');
  });

  it('is believed, but never as much as the settlement the brief describes', async () => {
    await movements.upsertMany([
      ...saleOn('2026-04-14'),
      credit('2026-04-15', 6_000_000, 'a'),
      credit('2026-04-15', 3_600_000, 'b'),
    ]);

    const [split] = (await run()).matches;

    // Everything else is perfect — exact amount, T+1, right counterparty, the
    // identity closes — and it still cannot reach CONFIRMED, because one
    // check about the shape of the settlement failed.
    expect(split?.status).toBe('PROBABLE');
    expect(split?.confidence.score).toBeLessThan(85);
    expect(split?.confidence.score).toBeGreaterThan(60);
  });

  it('never outbids the single credit the brief describes', async () => {
    // The same money available both ways: one credit for the whole net, and
    // two that also add up to it. The single one must win.
    await movements.upsertMany([
      ...saleOn('2026-04-14'),
      credit('2026-04-15', NET, 'whole'),
      credit('2026-04-16', 5_000_000, 'half-a'),
      credit('2026-04-16', 4_600_000, 'half-b'),
    ]);

    const [match] = (await run()).matches;

    expect(match?.status).toBe('CONFIRMED');
    expect(match?.right?.movementIds).toHaveLength(1);
    expect(match?.rule.id).toBe('SCHEDULED_SETTLEMENT');
  });

  it('proposes nothing when a single credit already explains the batch alone', async () => {
    await movements.upsertMany([...saleOn('2026-04-14'), credit('2026-04-15', NET, 'whole')]);

    const candidates = new SplitSettlementRule().evaluate(
      {
        id: 'bat_x' as never,
        accountId: WOMPI_ACCOUNT,
        batchDate: date('2026-04-14'),
        chargeIds: [],
        gross: Money.ofCents(GROSS),
        deductions: [],
        expectedNet: Money.ofCents(NET),
      },
      [credit('2026-04-15', NET, 'whole')],
      {
        calendar: new BusinessCalendar(TEST_HOLIDAYS),
        ruleSet: testRuleSet(),
        channel: 'wompi',
        policy: testRuleSet().settlementPolicyFor('wompi'),
      },
    );

    // One eligible credit is not a split, so the rule stays silent rather
    // than producing a one-element "combination".
    expect(candidates).toHaveLength(0);
  });
});
