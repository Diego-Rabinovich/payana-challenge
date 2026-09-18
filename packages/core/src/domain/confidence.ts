import { ConfigurationError } from './errors.js';
import type { Evidence, EvidenceCode } from './evidence.js';

/**
 * Confidence as an auditable sum, not a probability.
 *
 * Every point has a name, a weight that lives in a versioned config file, and
 * an Evidence entry saying what was expected and what was found. That is what
 * lets a CFO argue with a score instead of having to believe it, and what
 * makes the result reproducible bit for bit. See ADR-0005.
 */

export type MatchBand = 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNMATCHED';

export interface Confidence {
  /** Normalised 0–100. Never travels without `components`. */
  readonly score: number;
  readonly band: MatchBand;
  readonly earned: number;
  readonly attainable: number;
  readonly components: readonly Evidence[];
}

export interface ScoringConfig {
  readonly weights: Readonly<Partial<Record<EvidenceCode, number>>>;
  /**
   * Codes that answer the same question and so cannot both apply: an amount
   * is either exact, or within rounding, or explained by an implied fee.
   */
  readonly exclusiveDimensions: Readonly<Record<string, readonly EvidenceCode[]>>;
  readonly bands: { readonly CONFIRMED: number; readonly PROBABLE: number; readonly AMBIGUOUS: number };
  /** A runner-up this close forces AMBIGUOUS regardless of score. */
  readonly ambiguityDelta: number;
}

/**
 * The highest score any match could reach.
 *
 * Derived from the config rather than hardcoded, so editing a weight cannot
 * silently shift what a band means. Exclusive dimensions contribute their best
 * option once; everything else contributes its own weight.
 */
export function attainableScore(config: ScoringConfig): number {
  const exclusive = new Set<EvidenceCode>(Object.values(config.exclusiveDimensions).flat());

  const fromDimensions = Object.values(config.exclusiveDimensions).reduce((total, codes) => {
    const best = Math.max(0, ...codes.map((code) => config.weights[code] ?? 0));
    return total + best;
  }, 0);

  const fromIndependent = Object.entries(config.weights).reduce(
    (total, [code, weight]) => (exclusive.has(code as EvidenceCode) ? total : total + (weight ?? 0)),
    0,
  );

  const attainable = fromDimensions + fromIndependent;
  if (attainable <= 0) {
    throw new ConfigurationError('Ruleset weights sum to zero; every score would be undefined', {
      weights: config.weights,
    });
  }
  return attainable;
}

export interface ScoringOptions {
  /** The best competing candidate's score, on the same scale. */
  readonly runnerUpScore?: number;
  /** Set when the caller already established the field is contested. */
  readonly contested?: boolean;
}

/**
 * Scores the evidence for one candidate.
 *
 * Ambiguity is a property of the field of candidates rather than of this one,
 * so it arrives as an option. Reporting it is the whole point: an ambiguous
 * match presented as resolved would be the worst defect this system could have.
 */
export function scoreMatch(
  evidence: readonly Evidence[],
  config: ScoringConfig,
  options: ScoringOptions = {},
): Confidence {
  const attainable = attainableScore(config);
  const passed = evidence.filter((item) => item.passed);

  const exclusiveByCode = new Map<EvidenceCode, string>();
  for (const [dimension, codes] of Object.entries(config.exclusiveDimensions)) {
    for (const code of codes) exclusiveByCode.set(code, dimension);
  }

  // Take the best option per exclusive dimension rather than summing them, so
  // a rule that mistakenly emits two cannot inflate its own score.
  const bestPerDimension = new Map<string, number>();
  let earned = 0;
  for (const item of passed) {
    const weight = config.weights[item.code] ?? 0;
    const dimension = exclusiveByCode.get(item.code);
    if (dimension === undefined) {
      earned += weight;
      continue;
    }
    bestPerDimension.set(dimension, Math.max(bestPerDimension.get(dimension) ?? 0, weight));
  }
  for (const weight of bestPerDimension.values()) earned += weight;

  const score = Math.round((earned / attainable) * 100);
  return {
    score,
    band: bandFor(score, config, options),
    earned,
    attainable,
    components: evidence,
  };
}

function bandFor(score: number, config: ScoringConfig, options: ScoringOptions): MatchBand {
  const contested =
    options.contested === true ||
    (options.runnerUpScore !== undefined &&
      score - options.runnerUpScore <= config.ambiguityDelta);

  if (score < config.bands.AMBIGUOUS) return 'UNMATCHED';
  if (contested) return 'AMBIGUOUS';
  if (score >= config.bands.CONFIRMED) return 'CONFIRMED';
  if (score >= config.bands.PROBABLE) return 'PROBABLE';
  return 'AMBIGUOUS';
}
