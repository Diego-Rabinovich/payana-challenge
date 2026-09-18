import { describe, expect, it } from 'vitest';
import { type ScoringConfig, attainableScore, scoreMatch } from '../src/domain/confidence.js';
import { evidence } from '../src/domain/evidence.js';

// Mirrors config/ruleset.v1.json.
const config: ScoringConfig = {
  weights: {
    AMOUNT_EXACT: 50,
    AMOUNT_WITHIN_ROUNDING: 30,
    IMPLIED_FEE_IN_BAND: 25,
    DATE_T1_EXACT: 25,
    DATE_IN_WINDOW: 15,
    DESCRIPTOR_MATCH: 15,
    UNIQUE_CANDIDATE: 10,
    IDENTITY_HOLDS: 10,
  },
  exclusiveDimensions: {
    AMOUNT: ['AMOUNT_EXACT', 'AMOUNT_WITHIN_ROUNDING', 'IMPLIED_FEE_IN_BAND'],
    DATE: ['DATE_T1_EXACT', 'DATE_IN_WINDOW'],
  },
  bands: { CONFIRMED: 85, PROBABLE: 60, AMBIGUOUS: 40 },
  ambiguityDelta: 10,
};

const perfect = [
  evidence('AMOUNT_EXACT', 'AMOUNT', true, { weight: 50 }),
  evidence('DATE_T1_EXACT', 'DATE', true, { weight: 25 }),
  evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true, { weight: 15 }),
  evidence('UNIQUE_CANDIDATE', 'UNIQUENESS', true, { weight: 10 }),
  evidence('IDENTITY_HOLDS', 'INTEGRITY', true, { weight: 10 }),
];

describe('attainableScore', () => {
  it('counts each exclusive dimension once, at its best option', () => {
    // 50 (best AMOUNT) + 25 (best DATE) + 15 + 10 + 10
    expect(attainableScore(config)).toBe(110);
  });

  it('is derived from the config, so editing a weight moves it', () => {
    expect(attainableScore({ ...config, weights: { ...config.weights, IDENTITY_HOLDS: 20 } })).toBe(120);
  });
});

describe('scoreMatch (F02-T04, F02-T05)', () => {
  it('scores a textbook match at 100 and CONFIRMED', () => {
    const result = scoreMatch(perfect, config);

    expect(result.earned).toBe(110);
    expect(result.attainable).toBe(110);
    expect(result.score).toBe(100);
    expect(result.band).toBe('CONFIRMED');
  });

  it('normalises a weaker match into a meaningful number, not a raw sum', () => {
    // Implied fee + landed at T+2: 25 + 15 + 15 + 10 = 65 of 110.
    const result = scoreMatch(
      [
        evidence('IMPLIED_FEE_IN_BAND', 'AMOUNT', true, { weight: 25 }),
        evidence('DATE_IN_WINDOW', 'DATE', true, { weight: 15 }),
        evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true, { weight: 15 }),
        evidence('UNIQUE_CANDIDATE', 'UNIQUENESS', true, { weight: 10 }),
      ],
      config,
    );

    expect(result.earned).toBe(65);
    expect(result.score).toBe(59);
    expect(result.band).toBe('AMBIGUOUS');
  });

  it('ignores failed checks but still reports them', () => {
    const result = scoreMatch(
      [...perfect.slice(0, 4), evidence('IDENTITY_BROKEN', 'INTEGRITY', false)],
      config,
    );

    expect(result.earned).toBe(100);
    expect(result.components).toHaveLength(5);
    expect(result.components.some((c) => !c.passed)).toBe(true);
  });

  it('cannot be inflated by a rule emitting two codes for one dimension', () => {
    const result = scoreMatch(
      [
        evidence('AMOUNT_EXACT', 'AMOUNT', true, { weight: 50 }),
        evidence('AMOUNT_WITHIN_ROUNDING', 'AMOUNT', true, { weight: 30 }),
        evidence('DATE_T1_EXACT', 'DATE', true, { weight: 25 }),
      ],
      config,
    );

    // 50, not 80: an amount is exact or it is within rounding, never both.
    expect(result.earned).toBe(50 + 25);
  });

  it('carries its components, so the number never travels alone', () => {
    expect(scoreMatch(perfect, config).components).toEqual(perfect);
  });
});

describe('scoreMatch — ambiguity is reported, never resolved quietly', () => {
  it('downgrades a perfect match when a rival is within the delta', () => {
    const result = scoreMatch(perfect, config, { runnerUpScore: 92 });

    expect(result.score).toBe(100);
    expect(result.band).toBe('AMBIGUOUS');
  });

  it('leaves it CONFIRMED when the rival is far enough behind', () => {
    expect(scoreMatch(perfect, config, { runnerUpScore: 80 }).band).toBe('CONFIRMED');
  });

  it('treats two identical candidates as ambiguous', () => {
    expect(scoreMatch(perfect, config, { runnerUpScore: 100 }).band).toBe('AMBIGUOUS');
  });
});

describe('scoreMatch — bands', () => {
  const amountExact = evidence('AMOUNT_EXACT', 'AMOUNT', true);
  const impliedFee = evidence('IMPLIED_FEE_IN_BAND', 'AMOUNT', true);
  const dateT1 = evidence('DATE_T1_EXACT', 'DATE', true);
  const dateInWindow = evidence('DATE_IN_WINDOW', 'DATE', true);
  const descriptor = evidence('DESCRIPTOR_MATCH', 'DESCRIPTOR', true);

  it.each([
    ['everything checks out', perfect, 100, 'CONFIRMED'],
    ['exact amount, T+1, right descriptor', [amountExact, dateT1, descriptor], 82, 'PROBABLE'],
    ['exact amount and T+1 only', [amountExact, dateT1], 68, 'PROBABLE'],
    ['inferred fee, landed late', [impliedFee, dateInWindow], 36, 'UNMATCHED'],
    ['inferred fee alone', [impliedFee], 23, 'UNMATCHED'],
    ['nothing at all', [], 0, 'UNMATCHED'],
  ])('%s → %i, %s', (_case, items, expectedScore, expectedBand) => {
    const result = scoreMatch(items, config);

    expect(result.score).toBe(expectedScore);
    expect(result.band).toBe(expectedBand);
  });
});
