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

describe('two batches paid in one transfer', () => {
  it('reports the pair rather than filing both as unmatched', async () => {
    // The real case: 2026-02-21 and 2026-02-23 total $29.414.683 and the
    // $28.145.645,23 credited on the 24th is 4,31% below that. Neither batch
    // can claim the credit alone, so neither does — but saying nothing is
    // known about them would be false.
    const { MergedSettlementRule } = await import('../src/rules/merged-settlement.rule.js');
    const ruleSet = testRuleSet();

    const batchOf = (iso: string, cents: number) =>
      buildSettlementBatches({
        calendar: CAL,
        accountId: WOMPI_ACCOUNT,
        movements: [charge(iso, cents)],
      })[0]!;

    const first = batchOf('2026-02-20', 2_593_689_600);
    const second = batchOf('2026-02-23', 347_778_700);

    const credit = aMovement({
      accountId: WOMPI_ACCOUNT,
      externalId: 'credit-merged',
      valueDate: date('2026-02-24'),
      type: 'TRANSFER_IN',
      amount: Money.ofCents(2_814_564_523),
      description: 'PAGO DE PROV WOMPI S.A.S.',
      counterparty: 'WOMPI S.A.S.',
    });

    const candidates = new MergedSettlementRule().evaluate(second, [credit], {
      calendar: CAL,
      ruleSet,
      channel: 'wompi',
      policy: ruleSet.settlementPolicyFor('wompi'),
      batches: [first, second],
    });

    expect(candidates).toHaveLength(1);
    // It claims nothing: a candidate with no deposits can never win the
    // assignment, so it cannot steal the credit from anyone.
    expect(candidates[0]!.deposits).toEqual([]);

    const merged = candidates[0]!.evidence.find((item) => item.code === 'SETTLEMENT_MERGED');
    expect(merged).toBeDefined();
    expect(merged!.detail).toContain('2026-02-20');
    expect(merged!.detail).toContain('4,31%');
  });

  it('picks the best-fitting credit, whatever order the credits arrive in', async () => {
    // Dos créditos entran en la banda admisible (4–5%): uno al 4,31% y otro al
    // 4,95%. Antes ganaba el primero que aparecía; ahora gana el más cerca del
    // centro de la banda, y eso no puede depender del orden de los datos.
    const { MergedSettlementRule } = await import('../src/rules/merged-settlement.rule.js');
    const ruleSet = testRuleSet();

    const batchOf = (iso: string, cents: number) =>
      buildSettlementBatches({ calendar: CAL, accountId: WOMPI_ACCOUNT, movements: [charge(iso, cents)] })[0]!;
    const first = batchOf('2026-02-20', 2_593_689_600);
    const second = batchOf('2026-02-23', 347_778_700);

    const credit = (id: string, cents: number) =>
      aMovement({
        accountId: WOMPI_ACCOUNT,
        externalId: id,
        valueDate: date('2026-02-24'),
        type: 'TRANSFER_IN',
        amount: Money.ofCents(cents),
        description: 'PAGO DE PROV WOMPI S.A.S.',
        counterparty: 'WOMPI S.A.S.',
      });
    const cerca = credit('cerca', 2_814_564_523); // 4,31%
    const lejos = credit('lejos', 2_795_847_645); // 4,95%

    const detailFor = (deposits: ReturnType<typeof credit>[]) =>
      new MergedSettlementRule()
        .evaluate(second, deposits, {
          calendar: CAL,
          ruleSet,
          channel: 'wompi',
          policy: ruleSet.settlementPolicyFor('wompi'),
          batches: [first, second],
        })[0]!
        .evidence.find((item) => item.code === 'SETTLEMENT_MERGED')!.detail;

    expect(detailFor([lejos, cerca])).toContain('4,31%');
    expect(detailFor([cerca, lejos])).toContain('4,31%');
    // Y no le dice «habitual» a algo que sólo se comparó contra lo posible.
    expect(detailFor([cerca])).not.toContain('habitual');
  });

  it('stays quiet when a batch settles on its own', async () => {
    const { MergedSettlementRule } = await import('../src/rules/merged-settlement.rule.js');
    const ruleSet = testRuleSet();

    const only = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [charge('2026-02-23', 347_778_700)],
    })[0]!;

    const credit = aMovement({
      accountId: WOMPI_ACCOUNT,
      externalId: 'credit-own',
      valueDate: date('2026-02-24'),
      type: 'TRANSFER_IN',
      amount: Money.ofCents(332_785_000),
      counterparty: 'WOMPI S.A.S.',
    });

    expect(
      new MergedSettlementRule().evaluate(only, [credit], {
        calendar: CAL,
        ruleSet,
        channel: 'wompi',
        policy: ruleSet.settlementPolicyFor('wompi'),
        batches: [only],
      }),
    ).toEqual([]);
  });
});
