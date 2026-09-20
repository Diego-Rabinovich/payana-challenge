/**
 * What this run's settlements say the channel usually charges.
 *
 * Derived per run, never configured. The distinction matters and it took a
 * wrong turn to see it: a band written into the ruleset describes whoever
 * measured it last, on whatever period they happened to look at, and then
 * quietly grades every future run against a past one. What a settlement should
 * be compared against is the population it belongs to.
 *
 * The order is what keeps this honest:
 *
 *   1. the ruleset declares an *admissible* band — a guard, a prior, the only
 *      thing that can reject a candidate;
 *   2. matching runs against that band alone, so what matched what is decided
 *      without any knowledge of the run's own distribution;
 *   3. the typical band is measured over the settlements that matched;
 *   4. a second pass only *adds* points to the ones inside it.
 *
 * Because step 4 cannot create or destroy a match — only make one more
 * credible — using the run's own data here is not circular. It would be if
 * the derived band could reject anything, which is precisely why it cannot.
 */

export interface RateCalibration {
  readonly settlements: number;
  readonly median: number;
  /** Population standard deviation, in the same units as the rate. */
  readonly deviation: number;
  /** Median ± one deviation. What the second pass rewards. */
  readonly typicalBand: readonly [number, number];
}

/**
 * Three settlements is the floor.
 *
 * Below it "usual" has no meaning — two observations always look like a
 * cluster — so no band is produced and the second pass awards nothing. A run
 * of two settlements reporting less confidence than a run of fifty is the
 * correct outcome, not a gap to paper over.
 */
const MINIMUM_OBSERVATIONS = 3;

export function calibrateRates(rates: readonly number[]): RateCalibration | undefined {
  if (rates.length < MINIMUM_OBSERVATIONS) return undefined;

  const sorted = [...rates].sort((a, b) => a - b);
  const median = medianOf(sorted);
  const mean = sorted.reduce((total, rate) => total + rate, 0) / sorted.length;
  const deviation = Math.sqrt(
    sorted.reduce((total, rate) => total + (rate - mean) ** 2, 0) / sorted.length,
  );

  return {
    settlements: sorted.length,
    median,
    deviation,
    // Median rather than mean as the centre: one settlement whose gap includes
    // something other than a commission would drag a mean, and the band is
    // meant to describe the cluster rather than be pulled around by what
    // falls outside it.
    typicalBand: [round(median - deviation), round(median + deviation)],
  };
}

export function isTypical(rate: number, calibration: RateCalibration | undefined): boolean {
  if (!calibration) return false;
  const [low, high] = calibration.typicalBand;
  return rate >= low && rate <= high;
}

function medianOf(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/** Four decimals: a band reads as 0.0427, not as 0.042699999999999996. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
