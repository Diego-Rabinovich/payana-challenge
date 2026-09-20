import type { ChannelDto } from '@aa/contracts';
import type { ChannelView, MatchResult, RuleSet } from '@aa/core';
import { describeCadence } from '@aa/core';

/**
 * A channel's settings, and what the last run observed about them.
 *
 * Calibration here is a reading rather than a procedure. Nothing is fitted on
 * demand and nothing is written back: the run already produced an implied
 * deduction rate for every settlement, so the honest thing to show is the
 * distribution of those rates next to the band the config declares, and let a
 * person decide whether the two still describe each other.
 *
 * Deliberately not a button. A "calibrate" action would fit a band on the
 * settlements it is about to judge with that same band, which is circular —
 * the measurement is only worth anything as a suggestion a person carries into
 * `config/ruleset.v1.json`, where it lands with its provenance next to it.
 */
export function describeChannel(
  key: string,
  ruleSet: RuleSet,
  matches: readonly MatchResult[],
): ChannelView {
  const policy = ruleSet.settlementPolicyFor(key);
  const { admissible, typical } = ruleSet.feeBandsFor(key);
  const declared = ruleSet.config.channels[key];

  const rates = matches
    .map((match) => match.derivedDeductions?.impliedRate)
    .filter((rate): rate is number => rate !== undefined)
    .sort((a, b) => a - b);

  // A channel whose source states its own deductions has nothing to calibrate:
  // there is no implied rate because nothing had to be implied.
  const settled = matches.filter((match) => match.right !== null).length;
  const reported = settled > 0 && rates.length === 0;

  return {
    key,
    counterpartyPatterns: [...(declared?.counterpartyPatterns ?? [])],
    cadence: describeCadence(policy),
    ...(policy.cutoff ? { cutoff: `${policy.cutoff.time} ${policy.cutoff.timeZone}` } : {}),
    window: policy.window,
    admissibleBand: admissible,
    typicalBand: typical,
    declaresOwnBand: declared?.deductions !== undefined,
    calibration: {
      settlements: settled,
      deductionsAreReported: reported,
      observedRates: rates,
      ...summarise(rates),
      insideTypical: rates.filter((rate) => within(rate, typical)).length,
      insideAdmissible: rates.filter((rate) => within(rate, admissible)).length,
    },
  };
}

/**
 * Median and population standard deviation, and the band they imply.
 *
 * Median rather than mean because one settlement whose gap includes something
 * other than a commission would drag a mean; the whole point of the reading is
 * to describe the cluster, not to be pulled around by what falls outside it.
 */
function summarise(rates: readonly number[]) {
  if (rates.length < 3) return {};

  const median = rates[Math.floor(rates.length / 2)]!;
  const mean = rates.reduce((total, rate) => total + rate, 0) / rates.length;
  const deviation = Math.sqrt(
    rates.reduce((total, rate) => total + (rate - mean) ** 2, 0) / rates.length,
  );

  return {
    median,
    deviation,
    suggestedTypicalBand: [
      round(median - deviation),
      round(median + deviation),
    ] as readonly [number, number],
  };
}

/** Four decimals: a band is written as 0.0425, not as 0.042499999999. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function within(rate: number, [low, high]: readonly [number, number]): boolean {
  return rate >= low && rate <= high;
}

/** Readonly tuples become plain arrays; nothing else changes on the way out. */
export function toChannelDto(channel: ChannelView): ChannelDto {
  const { calibration } = channel;

  return {
    key: channel.key,
    counterpartyPatterns: [...channel.counterpartyPatterns],
    cadence: channel.cadence,
    ...(channel.cutoff ? { cutoff: channel.cutoff } : {}),
    window: { ...channel.window },
    admissibleBand: [channel.admissibleBand[0], channel.admissibleBand[1]],
    typicalBand: [channel.typicalBand[0], channel.typicalBand[1]],
    declaresOwnBand: channel.declaresOwnBand,
    calibration: {
      settlements: calibration.settlements,
      deductionsAreReported: calibration.deductionsAreReported,
      observedRates: [...calibration.observedRates],
      ...(calibration.median !== undefined ? { median: calibration.median } : {}),
      ...(calibration.deviation !== undefined ? { deviation: calibration.deviation } : {}),
      ...(calibration.suggestedTypicalBand
        ? {
            suggestedTypicalBand: [
              calibration.suggestedTypicalBand[0],
              calibration.suggestedTypicalBand[1],
            ] as [number, number],
          }
        : {}),
      insideTypical: calibration.insideTypical,
      insideAdmissible: calibration.insideAdmissible,
    },
  };
}
