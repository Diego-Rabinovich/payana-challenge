import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { Money } from '../src/domain/money.js';
import { ReconcileFlow } from '../src/usecases/reconcile-flow.js';
import { ScheduledSettlementRule } from '../src/rules/scheduled-settlement.rule.js';
import { SplitSettlementRule } from '../src/rules/split-settlement.rule.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { BANK_ACCOUNT, WOMPI_ACCOUNT, aMovement } from '../src/testing/builders.js';
import { TEST_HOLIDAYS, testRuleSet } from '../src/testing/ruleset-fixture.js';

/**
 * The ambiguity the brief warns about: several subsets that add to the same
 * amount, where arithmetic alone cannot choose.
 *
 * It does not occur in the four months of real data — measured: no credit of
 * the 58 admits more than one combination of charges within two pesos, because
 * the batch structure fixes the subset and the amounts are distinctive. That
 * is a fact about this dataset, not a property of the system, so the machinery
 * is exercised here against a case built to be ambiguous. A system that only
 * works on the data it was written against has not been tested.
 */

const CAL = new BusinessCalendar(TEST_HOLIDAYS);
const date = (iso: string) => Temporal.PlainDate.from(iso);

describe('several subsets adding to the same total', () => {
  it('reports the ambiguity instead of picking one', async () => {
    const movements = new InMemoryMovementRepository();

    // One batch of $1.000.000 expecting $956.900 net at the usual rate, and
    // four credits where two different pairs reach it: 500.000 + 456.900 and
    // 600.000 + 356.900.
    await movements.upsertMany([
      aMovement({
        accountId: WOMPI_ACCOUNT,
        externalId: 'sale',
        valueDate: date('2026-03-02'),
        type: 'CHARGE',
        amount: Money.ofCents(100_000_000),
      }),
      ...[
        ['a', 50_000_000],
        ['b', 45_690_000],
        ['c', 60_000_000],
        ['d', 35_690_000],
      ].map(([tag, cents]) =>
        aMovement({
          accountId: BANK_ACCOUNT,
          externalId: `credit-${tag}`,
          valueDate: date('2026-03-03'),
          type: 'TRANSFER_IN',
          amount: Money.ofCents(cents as number),
          description: 'PAGO DE PROV WOMPI S.A.S.',
          counterparty: 'WOMPI S.A.S.',
        }),
      ),
    ]);

    const report = await new ReconcileFlow(
      movements,
      CAL,
      testRuleSet(),
      [new ScheduledSettlementRule(), new SplitSettlementRule()],
    ).execute({
      gatewayAccountId: WOMPI_ACCOUNT,
      bankAccountId: BANK_ACCOUNT,
      channel: 'wompi',
      range: { from: date('2026-03-02'), to: date('2026-03-02') },
    });

    const [match] = report.matches;
    const codes = match!.confidence.components.map((item) => item.code);

    // Whichever subset won, the result says others existed.
    expect(codes).toContain('SUBSET_SUM_MULTIPLE');
    expect(match!.status).toBe('AMBIGUOUS');
    // And the ones it did not take stay visible rather than disappearing.
    expect(match!.alternatives.length).toBeGreaterThan(0);
  });

  it('says nothing about alternatives when only one subset works', async () => {
    const movements = new InMemoryMovementRepository();
    await movements.upsertMany([
      aMovement({
        accountId: WOMPI_ACCOUNT,
        externalId: 'sale-single',
        valueDate: date('2026-03-02'),
        type: 'CHARGE',
        amount: Money.ofCents(100_000_000),
      }),
      aMovement({
        accountId: BANK_ACCOUNT,
        externalId: 'credit-whole',
        valueDate: date('2026-03-03'),
        type: 'TRANSFER_IN',
        amount: Money.ofCents(95_690_000),
        description: 'PAGO DE PROV WOMPI S.A.S.',
        counterparty: 'WOMPI S.A.S.',
      }),
    ]);

    const report = await new ReconcileFlow(
      movements,
      CAL,
      testRuleSet(),
      [new ScheduledSettlementRule(), new SplitSettlementRule()],
    ).execute({
      gatewayAccountId: WOMPI_ACCOUNT,
      bankAccountId: BANK_ACCOUNT,
      channel: 'wompi',
      range: { from: date('2026-03-02'), to: date('2026-03-02') },
    });

    const codes = report.matches[0]!.confidence.components.map((item) => item.code);
    expect(codes).not.toContain('SUBSET_SUM_MULTIPLE');
    expect(codes).toContain('SETTLEMENT_SINGLE_CREDIT');
  });
});
