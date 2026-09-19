import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { Money } from '../src/domain/money.js';
import { buildSettlementBatches } from '../src/domain/settlement-batch.js';
import { scoreMatch } from '../src/domain/confidence.js';
import { evidence } from '../src/domain/evidence.js';
import { WOMPI_ACCOUNT, aMovement } from '../src/testing/builders.js';
import { TEST_HOLIDAYS, TEST_RULESET_CONFIG, testRuleSet } from '../src/testing/ruleset-fixture.js';

/**
 * What four months of real statements taught this model.
 *
 * Each of these was a wrong answer the system gave with a straight face, and
 * each is now a test so it cannot come back.
 */

const CAL = new BusinessCalendar(TEST_HOLIDAYS);
const date = (iso: string) => Temporal.PlainDate.from(iso);

const charge = (iso: string, cents: number) =>
  aMovement({
    accountId: WOMPI_ACCOUNT,
    externalId: `tx-${iso}-${cents}`,
    valueDate: date(iso),
    type: 'CHARGE',
    amount: Money.ofCents(cents),
  });

describe('a weekend settles as one batch, not two', () => {
  it('puts Saturday and Sunday in Monday payment together', () => {
    // 2026-01-03 is a Saturday, 01-04 a Sunday, 01-05 a Monday. The real
    // statement shows one credit of $4.820.714,76 against the two days'
    // $5.038.130 of sales, at 4.32%.
    const batches = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [charge('2026-01-03', 19_570_000), charge('2026-01-04', 484_243_000)],
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]!.gross.cents).toBe(503_813_000);
    // Cut on the Sunday, so the window still reads T+1 business day: Monday.
    expect(batches[0]!.batchDate.toString()).toBe('2026-01-04');
    expect(CAL.nextBusinessDay(batches[0]!.batchDate, 1).toString()).toBe('2026-01-05');
  });

  it('rolls a holiday Monday into Tuesday batch', () => {
    // 2026-01-12 is Reyes Magos moved to the Monday, so Saturday through
    // Monday are one batch due on the Tuesday.
    const batches = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [
        charge('2026-01-10', 100_000),
        charge('2026-01-11', 200_000),
        charge('2026-01-12', 300_000),
      ],
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]!.gross.cents).toBe(600_000);
  });

  it('keeps ordinary weekdays apart', () => {
    const batches = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [charge('2026-01-14', 100_000), charge('2026-01-15', 200_000)],
    });

    expect(batches).toHaveLength(2);
  });
});

describe('a failed gate is not a weak match', () => {
  const ruleSet = testRuleSet();

  it('refuses to band a candidate whose amount is nowhere near', () => {
    // The real case: a batch of $4.842.430 against a credit of $257.940,85.
    // Date, descriptor and shape all passed, and it was reported AMBIGUOUS.
    const confidence = scoreMatch(
      [
        evidence('AMOUNT_MISMATCH', 'AMOUNT', false, { detail: 'delta COP -458448915' }),
        evidence('DATE_IN_WINDOW', 'DATE', true),
        evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true),
        evidence('SETTLEMENT_SINGLE_CREDIT', 'INTEGRITY', true),
      ],
      ruleSet.scoring,
    );

    expect(confidence.band).toBe('UNMATCHED');
    expect(confidence.disqualifiedBy).toBe('AMOUNT_MISMATCH');
  });

  it('still bands a candidate that only lost points', () => {
    const confidence = scoreMatch(
      [
        evidence('AMOUNT_EXACT', 'AMOUNT', true),
        evidence('DATE_IN_WINDOW', 'DATE', true),
        evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true),
        evidence('SETTLEMENT_SINGLE_CREDIT', 'INTEGRITY', true),
      ],
      ruleSet.scoring,
    );

    expect(confidence.band).not.toBe('UNMATCHED');
    expect(confidence.disqualifiedBy).toBeUndefined();
  });
});

describe('a check that could not be run costs nothing', () => {
  it('leaves the unverifiable identity out of the denominator', () => {
    const base = [
      evidence('IMPLIED_FEE_IN_BAND', 'AMOUNT', true),
      evidence('DATE_T1_EXACT', 'DATE', true),
      evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true),
      evidence('SETTLEMENT_SINGLE_CREDIT', 'INTEGRITY', true),
    ];
    const ruleSet = testRuleSet();

    const scoredAsFailure = scoreMatch(
      [...base, evidence('IDENTITY_BROKEN', 'INTEGRITY', false)],
      ruleSet.scoring,
    );
    const scoredAsInapplicable = scoreMatch(
      [...base, { ...evidence('IDENTITY_BROKEN', 'INTEGRITY', false), applicable: false }],
      ruleSet.scoring,
    );

    // Same evidence, but one says "we checked and it broke" and the other
    // says "there was nothing to check". The second must not cost points.
    expect(scoredAsInapplicable.attainable).toBe(
      scoredAsFailure.attainable - (TEST_RULESET_CONFIG.weights.IDENTITY_HOLDS ?? 0),
    );
    expect(scoredAsInapplicable.score).toBeGreaterThan(scoredAsFailure.score);
  });
});
