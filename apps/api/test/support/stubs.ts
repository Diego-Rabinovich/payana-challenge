import { Temporal } from '@js-temporal/polyfill';
import {
  type Evidence,
  type MatchResult,
  type Movement,
  Money,
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
import { NotFoundError } from '../../src/plugins/error-handler.js';
import type { ReadModel } from '@aa/core';
import { AccountMap } from '@aa/core';

/**
 * Stubs for the query ports, hand-written rather than generated.
 *
 * Because the ports are narrow (ISP), a stub is a few lines instead of a
 * mock framework — which is most of the argument for splitting them.
 */

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

export function testMatch(components: Evidence[] = [evidence('AMOUNT_EXACT', 'AMOUNT', true)]): MatchResult {
  return {
    id: matchId('mat_1'),
    rulesetVersion: 'v1-test',
    kind: 'CHANNEL_TO_BANK',
    status: 'CONFIRMED',
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
    confidence: { score: 100, band: 'CONFIRMED', earned: 110, attainable: 110, components },
    alternatives: [],
  };
}

/** The five accounts of the brief, so a presented entry names real codes. */
function stubAccountMap(): AccountMap {
  return AccountMap.from({
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
}

export function stubDependencies(): ReadModel {
  const match = testMatch();

  return {
    version: '0.1.0',
    rulesetVersion: 'v1-test',
    accountMap: stubAccountMap(),
    ruleSet: testRuleSet(),

    health: {
      sources: async () => [{ id: 'wompi:transactions', mode: 'fixtures', state: 'ready' }],
    },

    ledger: {
      listAccounts: async () => [
        { id: accountId('wompi:AA'), kind: 'GATEWAY', name: 'Wompi', currency: 'COP' },
      ],
      listMovements: async () => ({
        // The extra field is deliberate: the serialiser must drop it.
        items: [{ ...testMovement(), internalOnly: 'must not reach the wire' } as Movement],
        nextCursor: null,
        total: 1,
      }),
      correlationOf: async () => undefined,
      findMovements: async (ids) =>
        ids.includes('mov_a1b2c3d4e5f60718') ? [testMovement()] : [],
      findMovement: async (id) => (id === 'mov_a1b2c3d4e5f60718' ? testMovement() : undefined),
      lineageOf: async () => undefined,
    },

    flow: {
      listBatches: async () => [],
      findBatch: async () => undefined,
      listReconciliations: async () => [match],
      findReconciliation: async (_runId, id) => (id === 'mat_1' ? match : undefined),
      flowReport: async () => undefined,
    },

    erp: {
      erpReconciliation: async () => {
        throw new NotFoundError('ERP reconciliation');
      },
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
      // El stub reconoce una sola corrida y `latest`; cualquier otra cosa es
      // un 404, que es justamente lo que un test de alcance quiere poder ver.
      resolve: async (runId) => (runId === 'latest' || runId === 'run_1' ? 'run_1' : undefined),
      start: async ({ from, to }) => ({
        id: 'run_1',
        startedAt: '2026-04-30T12:00:00.000Z',
        rulesetVersion: 'v1-test',
        range: { from, to },
        inputHashes: {},
      }),
      reportArtifact: async () => undefined,
    },
  };
}
