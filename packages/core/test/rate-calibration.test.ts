import { describe, expect, it } from 'vitest';
import { calibrateRates, isTypical } from '../src/domain/rate-calibration.js';

/**
 * The band is derived per run, and the order in which it is derived is what
 * keeps it honest. These tests pin that order.
 */
describe('calibrateRates', () => {
  it('describes the cluster the run actually produced', () => {
    // The real distribution, rounded: mostly 4,3 with a tail to 4,7.
    const rates = [0.043, 0.0431, 0.0432, 0.0435, 0.044, 0.0445, 0.045, 0.0469];

    const calibration = calibrateRates(rates)!;

    expect(calibration.settlements).toBe(8);
    expect(calibration.median).toBeGreaterThan(0.043);
    expect(calibration.median).toBeLessThan(0.0445);
    const [low, high] = calibration.typicalBand;
    expect(low).toBeLessThan(calibration.median);
    expect(high).toBeGreaterThan(calibration.median);
  });

  it('refuses to call anything usual with fewer than three observations', () => {
    // Two observations always look like a cluster. A run that small reporting
    // less confidence than a large one is the correct outcome.
    expect(calibrateRates([0.043, 0.0431])).toBeUndefined();
    expect(calibrateRates([])).toBeUndefined();
    expect(isTypical(0.043, undefined)).toBe(false);
  });

  it('uses the median, so one outlier cannot drag the centre', () => {
    const clean = [0.043, 0.0431, 0.0432, 0.0433, 0.0434];
    const withOutlier = [...clean, 0.2];

    // The mean would move by three points; the median barely moves.
    expect(
      Math.abs(calibrateRates(withOutlier)!.median - calibrateRates(clean)!.median),
    ).toBeLessThan(0.0005);
  });

  it('is a band, not a point: the edges are a deviation out', () => {
    const rates = [0.04, 0.042, 0.044, 0.046, 0.048];
    const calibration = calibrateRates(rates)!;

    expect(isTypical(calibration.median, calibration)).toBe(true);
    expect(isTypical(calibration.typicalBand[0], calibration)).toBe(true);
    expect(isTypical(calibration.typicalBand[1], calibration)).toBe(true);
    expect(isTypical(0.2, calibration)).toBe(false);
  });
});
