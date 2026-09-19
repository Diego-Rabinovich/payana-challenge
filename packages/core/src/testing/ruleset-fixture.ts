import { RuleSet, type RuleSetConfig } from '../domain/ruleset.js';

/** Mirrors config/ruleset.v1.json, so tests exercise the shipped numbers. */
export const TEST_RULESET_CONFIG: RuleSetConfig = {
  version: 'v1-test',
  settlementWindow: { fromBusinessDays: 1, toBusinessDays: 3 },
  tolerances: {
    roundingCents: 10_000,
    identityCents: 1,
    impliedFeeRateBand: [0.02, 0.05],
    typicalFeeRateBand: [0.0425, 0.0445],
  },
  weights: {
    AMOUNT_EXACT: 50,
    AMOUNT_WITHIN_ROUNDING: 25,
    IMPLIED_FEE_TYPICAL: 40,
    IMPLIED_FEE_IN_BAND: 25,
    DATE_T1_EXACT: 25,
    DATE_IN_WINDOW: 15,
    DESCRIPTOR_MATCH: 15,
    UNIQUE_CANDIDATE: 10,
    IDENTITY_HOLDS: 10,
    SETTLEMENT_SINGLE_CREDIT: 25,
  },
  exclusiveDimensions: {
    AMOUNT: ['AMOUNT_EXACT', 'IMPLIED_FEE_TYPICAL', 'AMOUNT_WITHIN_ROUNDING', 'IMPLIED_FEE_IN_BAND'],
    DATE: ['DATE_T1_EXACT', 'DATE_IN_WINDOW'],
  },
  bands: { CONFIRMED: 85, PROBABLE: 60, AMBIGUOUS: 40 },
  ambiguityDelta: 10,
  disqualifying: ['AMOUNT_MISMATCH', 'DESCRIPTOR_FOREIGN', 'DATE_OUT_OF_WINDOW'],
  subsetSum: {
    maxSubsetSize: 60,
    maxSolutions: 5,
    toleranceCents: 100,
    maxNodes: 200_000,
  },
  channels: {
    wompi: { counterpartyPatterns: ['WOMPI'] },
    druo: { counterpartyPatterns: ['DRUO'] },
  },
};

export function testRuleSet(overrides: Partial<RuleSetConfig> = {}): RuleSet {
  return RuleSet.from({ ...TEST_RULESET_CONFIG, ...overrides });
}

/** The 2025–2026 holidays the settlement tests depend on. */
export const TEST_HOLIDAYS = ['2025-12-25', '2026-01-01', '2026-01-12', '2026-04-02', '2026-04-03'];
