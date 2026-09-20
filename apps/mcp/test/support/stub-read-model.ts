import { Temporal } from '@js-temporal/polyfill';
import {
  AccountMap,
  type ErpReconciliationReport,
  type Evidence,
  type MatchResult,
  Money,
  type Movement,
  type ReadModel,
  type ReconciliationReport,
  accountId,
  batchId,
  evidence,
  matchId,
  movementId,
  rawRecordId,
  sourceId,
} from '@aa/core';
import { RuleSet } from '@aa/core';

/** The shipped ruleset shape, trimmed to what the stubs exercise. */
function testRuleSet(): RuleSet {
  return RuleSet.from({
    version: 'v1-test',
    settlementWindow: { fromBusinessDays: 1, toBusinessDays: 3 },
    tolerances: { roundingCents: 10_000, identityCents: 1, impliedFeeRateBand: [0.02, 0.05] },
    weights: { AMOUNT_EXACT: 50, DATE_T1_EXACT: 25 },
    exclusiveDimensions: { AMOUNT: ['AMOUNT_EXACT'], DATE: ['DATE_T1_EXACT'] },
    bands: { CONFIRMED: 85, PROBABLE: 60, AMBIGUOUS: 40 },
    ambiguityDelta: 10,
    subsetSum: { maxSubsetSize: 60, maxSolutions: 5, toleranceCents: 100, maxNodes: 200_000 },
    channels: { wompi: { counterpartyPatterns: ['WOMPI'] } },
  });
}

/**
 * A read model that lives in memory.
 *
 * The tools are meant to read whatever the core produced, so the test has to
 * be able to hand them a known result and check what comes back out. The
 * query ports are narrow enough that this is a file rather than a framework.
 */

const CHART = AccountMap.from({
  journals: {
    wompi: { id: 48, name: 'Wompi Tarjetas', mainAccount: '1110001' },
    bancolombia: { id: 49, name: 'Bancolombia', mainAccount: '111001' },
  },
  accounts: {
    CHARGE: { code: '420500', name: 'Otras Ventas' },
    FEE: { code: '530505', name: 'Gastos Bancarios' },
    TAX: { code: '240810', name: 'IVA Descontable' },
    WITHHOLDING: { code: '236500', name: 'Retención En La Fuente' },
  },
});

export function testMovement(overrides: Partial<Movement> = {}): Movement {
  return {
    id: movementId('mov_a1b2c3d4e5f60718'),
    accountId: accountId('wompi:AA'),
    externalId: 'tkfgjokoqfhwvigu71qqq',
    occurredAt: Temporal.Instant.from('2026-04-24T23:44:00Z'),
    valueDate: Temporal.PlainDate.from('2026-04-24'),
    type: 'CHARGE',
    amount: Money.ofCents(31_754_900),
    counterparty: 'WOMPI S.A.S.',
    description: 'Pago aprobado',
    source: {
      sourceId: sourceId('wompi:transactions'),
      rawRecordId: rawRecordId('raw_1'),
      locator: 'tx=1',
    },
    metadata: {},
    ...overrides,
  };
}

function testMatch(id: string, band: 'CONFIRMED' | 'AMBIGUOUS'): MatchResult {
  const components: Evidence[] = [
    evidence('AMOUNT_EXACT', 'AMOUNT', true, { weight: 50 }),
    evidence('DATE_T1_EXACT', 'DATE', true, { weight: 25 }),
    evidence('SETTLEMENT_SINGLE_CREDIT', 'INTEGRITY', true, { weight: 25 }),
  ];

  return {
    id: matchId(id),
    rulesetVersion: 'v1-test',
    kind: 'CHANNEL_TO_BANK',
    status: band,
    left: {
      batchId: batchId('bat_1'),
      batchDate: Temporal.PlainDate.from('2026-04-24'),
      chargeIds: [movementId('mov_a1b2c3d4e5f60718')],
    },
    right: { movementIds: [movementId('mov_bank1')] },
    rule: { id: 'SCHEDULED_SETTLEMENT', version: 2 },
    amounts: {
      gross: Money.ofCents(31_754_900),
      deductions: Money.ofCents(1_411_948),
      expectedNet: Money.ofCents(30_342_952),
      observedNet: Money.ofCents(30_342_952),
      delta: Money.zero(),
    },
    window: {
      from: Temporal.PlainDate.from('2026-04-27'),
      to: Temporal.PlainDate.from('2026-04-29'),
      basis: 'BUSINESS_DAYS',
    },
    confidence: { score: 100, band, earned: 135, attainable: 135, components },
    alternatives: [
      { movementIds: [movementId('mov_bank2')], score: 71, rejectedBecause: 'AMOUNT_MISMATCH' },
    ],
  };
}

const FLOW_REPORT: ReconciliationReport = {
  rulesetVersion: 'v1-test',
  matches: [testMatch('mat_one', 'CONFIRMED'), testMatch('mat_two', 'AMBIGUOUS')],
  unattributed: [
    {
      movementId: movementId('mov_bank9'),
      valueDate: Temporal.PlainDate.from('2026-04-28'),
      amount: Money.ofCents(120_000),
      counterparty: 'OTRO PAGADOR',
      description: 'ABONO INTERESES',
      reason: 'DESCRIPTOR_FOREIGN',
    },
  ],
  totals: {
    batches: 2,
    byStatus: { CONFIRMED: 1, AMBIGUOUS: 1 },
    gross: Money.ofCents(63_509_800),
    deductions: Money.ofCents(2_823_896),
    deductionsAreDerived: true,
    expectedNet: Money.ofCents(60_685_904),
    observedNet: Money.ofCents(60_685_904),
    unexplained: Money.zero(),
  },
};

const ERP_REPORT: ErpReconciliationReport = {
  journalId: 48,
  journalName: 'Wompi Tarjetas',
  lines: [
    {
      status: 'MISSING_IN_ERP',
      matchLevel: 'NONE',
      ledgerMovementIds: [movementId('mov_a1b2c3d4e5f60718')],
      date: Temporal.PlainDate.from('2026-04-24'),
      ledgerAmount: Money.ofCents(31_754_900),
      evidence: [evidence('MISSING_IN_ERP', 'ERP', false)],
      correction: {
        ref: 'mov:mov_a1b2c3d4e5f60718',
        journalKey: 'wompi',
        date: Temporal.PlainDate.from('2026-04-24'),
        reason: 'MISSING_ENTRY',
        missingConcepts: [],
        lines: [{ concept: 'CHARGE', amount: Money.ofCents(31_754_900), label: 'Venta' }],
        netToAccount: Money.ofCents(31_754_900),
      },
    },
  ],
  totals: {
    ledgerGroups: 1,
    erpEntries: 0,
    byStatus: { MISSING_IN_ERP: 1 },
    ledgerTotal: Money.ofCents(31_754_900),
    erpTotal: Money.zero(),
    unexplained: Money.ofCents(-31_754_900),
  },
};

export function stubReadModel(): ReadModel {
  const movement = testMovement();

  return {
    version: '0.1.0',
    rulesetVersion: 'v1-test',
    accountMap: CHART,
    ruleSet: testRuleSet(),

    health: { sources: async () => [] },

    ledger: {
      listAccounts: async () => [],
      listMovements: async () => ({ items: [movement], nextCursor: null, total: 1 }),
      correlationOf: async () => undefined,
      findMovements: async (ids) =>
        ids.includes(movement.id) ? [movement] : [],
      findMovement: async (id) => (id === movement.id ? movement : undefined),
      lineageOf: async (id) =>
        id === movement.id
          ? {
              movementId: movement.id,
              gross: movement.amount,
              attributedNet: Money.ofCents(30_342_952),
              batchId: batchId('bat_1'),
              matchId: matchId('mat_one'),
              bankCreditId: movementId('mov_bank1'),
              settled: true,
              steps: [
                {
                  stage: 'CHARGE' as const,
                  ref: movement.id,
                  date: movement.valueDate,
                  amount: movement.amount,
                  detail: 'Pago aprobado',
                },
                {
                  stage: 'BANK_CREDIT' as const,
                  ref: movementId('mov_bank1'),
                  date: Temporal.PlainDate.from('2026-04-27'),
                  amount: Money.ofCents(30_342_952),
                  detail: 'PAGO DE PROV WOMPI S.A.S.',
                },
              ],
            }
          : undefined,
    },

    flow: {
      listBatches: async () => [],
      findBatch: async () => undefined,
      listReconciliations: async ({ status }) =>
        status
          ? FLOW_REPORT.matches.filter((m) => m.status === status.toUpperCase())
          : FLOW_REPORT.matches,
      findReconciliation: async (id) => FLOW_REPORT.matches.find((m) => m.id === id),
      flowReport: async () => FLOW_REPORT,
    },

    erp: {
      erpReconciliation: async ({ journalKey }) =>
        journalKey === 'wompi' ? ERP_REPORT : undefined,
    },

    channels: {
      list: async () => [],
    },

    corrections: {
      create: async () => {
        throw new Error('los stubs no escriben en ningun ERP');
      },
      written: async () => [],
      remove: async () => false,
    },

    statements: {
      list: async () => [{ name: 'Extracto_Abril.pdf', bytes: 512_000, receivedAt: '2026-05-01T00:00:00Z' }],
      add: async ({ filename }) => ({
        name: filename,
        bytes: 1,
        receivedAt: '2026-05-01T00:00:00Z',
      }),
    },

    runs: {
      list: async () => [],
      find: async () => undefined,
      start: async () => {
        throw new Error('the MCP server never starts a run');
      },
      reportArtifact: async () => undefined,
    },
  };
}
