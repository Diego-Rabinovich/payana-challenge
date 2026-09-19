import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { RuleSet } from '../src/domain/ruleset.js';
import { buildSettlementBatches } from '../src/domain/settlement-batch.js';
import { closingDateFor, describeCadence } from '../src/domain/settlement-policy.js';
import { ReconcileFlow } from '../src/usecases/reconcile-flow.js';
import { ScheduledSettlementRule } from '../src/rules/scheduled-settlement.rule.js';
import { SplitSettlementRule } from '../src/rules/split-settlement.rule.js';
import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { BANK_ACCOUNT, WOMPI_ACCOUNT, aMovement } from '../src/testing/builders.js';
import { TEST_HOLIDAYS, TEST_RULESET_CONFIG } from '../src/testing/ruleset-fixture.js';
import { Money } from '../src/domain/money.js';

const CAL = new BusinessCalendar(TEST_HOLIDAYS);

/**
 * The test the per-channel policy exists to pass.
 *
 * A source that batches weekly instead of daily must be a configuration
 * change and nothing else: no new rule, no new use case, no edit to any
 * domain type. If any of that were needed, the cadence would be hardcoded
 * business logic wearing a channel's name.
 */

const date = (iso: string) => Temporal.PlainDate.from(iso);

describe('closingDateFor', () => {
  it('leaves a daily channel on its own date', () => {
    const policy = { cadence: 'DAILY' as const, window: { fromBusinessDays: 1, toBusinessDays: 3 } };
    expect(closingDateFor(date('2026-04-15'), policy).toString()).toBe('2026-04-15');
  });

  it('carries a weekly channel forward to the day it closes on', () => {
    // Closes on Sunday, so Wednesday the 15th belongs to the 19th.
    const policy = {
      cadence: 'WEEKLY' as const,
      weekEndsOn: 7,
      window: { fromBusinessDays: 1, toBusinessDays: 3 },
    };
    expect(closingDateFor(date('2026-04-15'), policy).toString()).toBe('2026-04-19');
    expect(closingDateFor(date('2026-04-19'), policy).toString()).toBe('2026-04-19');
    expect(closingDateFor(date('2026-04-20'), policy).toString()).toBe('2026-04-26');
  });

  it('carries a monthly channel to its cutoff day', () => {
    const policy = {
      cadence: 'MONTHLY' as const,
      monthEndsOn: 31,
      window: { fromBusinessDays: 1, toBusinessDays: 5 },
    };
    expect(closingDateFor(date('2026-04-15'), policy).toString()).toBe('2026-04-30');
    expect(closingDateFor(date('2026-02-28'), policy).toString()).toBe('2026-02-28');
  });

  it('says how it batches in words the report can print', () => {
    expect(
      describeCadence({
        cadence: 'WEEKLY',
        weekEndsOn: 7,
        window: { fromBusinessDays: 1, toBusinessDays: 3 },
      }),
    ).toContain('domingo');
  });
});

describe('a weekly channel, added as configuration only', () => {
  // The whole channel: patterns, cadence and window. No code accompanies it.
  const WEEKLY_CHANNEL = {
    counterpartyPatterns: ['SEMANAL'],
    settlement: {
      cadence: 'WEEKLY' as const,
      weekEndsOn: 7,
      window: { fromBusinessDays: 1, toBusinessDays: 3 },
    },
  };

  const ruleSet = RuleSet.from({
    ...TEST_RULESET_CONFIG,
    channels: { ...TEST_RULESET_CONFIG.channels, semanal: WEEKLY_CHANNEL },
  });

  const charge = (iso: string, cents: number) =>
    aMovement({
      accountId: WOMPI_ACCOUNT,
      externalId: `tx-${iso}-${cents}`,
      valueDate: date(iso),
      type: 'CHARGE',
      amount: Money.ofCents(cents),
    });

  it('groups a whole week into one batch instead of five', () => {
    const week = [
      charge('2026-04-13', 100_000),
      charge('2026-04-14', 200_000),
      charge('2026-04-15', 300_000),
      charge('2026-04-16', 400_000),
      charge('2026-04-17', 500_000),
    ];

    const daily = buildSettlementBatches({ calendar: CAL, accountId: WOMPI_ACCOUNT, movements: week });
    expect(daily).toHaveLength(5);

    const weekly = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: week,
      policy: WEEKLY_CHANNEL.settlement,
    });
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.batchDate.toString()).toBe('2026-04-19');
    expect(weekly[0]!.gross.cents).toBe(1_500_000);
  });

  it('matches the week against the credit that lands after the close, not after each sale', async () => {
    const movements = new InMemoryMovementRepository();
    await movements.upsertMany([
      charge('2026-04-13', 100_000),
      charge('2026-04-15', 300_000),
      charge('2026-04-17', 500_000),
      aMovement({
        accountId: BANK_ACCOUNT,
        externalId: 'credit-weekly',
        // Monday the 20th: T+1 business day after the Sunday close. A daily
        // policy would have expected three separate credits, none on this day.
        valueDate: date('2026-04-20'),
        type: 'TRANSFER_IN',
        amount: Money.ofCents(900_000),
        description: 'PAGO DE PROV SEMANAL S.A.S.',
        counterparty: 'SEMANAL S.A.S.',
      }),
    ]);

    const report = await new ReconcileFlow(
      movements,
      new BusinessCalendar(TEST_HOLIDAYS),
      ruleSet,
      [new ScheduledSettlementRule(), new SplitSettlementRule()],
    ).execute({
      gatewayAccountId: WOMPI_ACCOUNT,
      bankAccountId: BANK_ACCOUNT,
      channel: 'semanal',
      range: { from: date('2026-04-13'), to: date('2026-04-19') },
    });

    expect(report.matches).toHaveLength(1);
    const [match] = report.matches;
    expect(match?.status).toBe('CONFIRMED');
    expect(match?.left.chargeIds).toHaveLength(3);
    expect(match?.window.from.toString()).toBe('2026-04-20');
    expect(match?.confidence.components.map((item) => item.code)).toContain('DATE_T1_EXACT');
  });
});

describe('a channel that declares nothing', () => {
  it('keeps the daily cut on the global window, so existing config is unchanged', () => {
    const ruleSet = RuleSet.from(TEST_RULESET_CONFIG);
    const policy = ruleSet.settlementPolicyFor('wompi');

    expect(policy.cadence).toBe('DAILY');
    expect(policy.window).toEqual(TEST_RULESET_CONFIG.settlementWindow);
  });

  it('refuses a weekly channel that does not say which day it closes on', () => {
    expect(() =>
      RuleSet.from({
        ...TEST_RULESET_CONFIG,
        channels: {
          broken: {
            counterpartyPatterns: ['X'],
            settlement: { cadence: 'WEEKLY', window: { fromBusinessDays: 1, toBusinessDays: 2 } },
          },
        },
      }),
    ).toThrow(/which day it closes on/);
  });
});
