import type { ChannelDto } from '@aa/contracts';
import type { ChannelView, MatchResult, RateCalibration, RuleSet } from '@aa/core';
import { describeCadence } from '@aa/core';

/**
 * A channel's settings, and what the last run measured about its commission.
 *
 * Nothing is fitted here. The run already derived its own typical band as part
 * of scoring — see `rate-calibration.ts` — so this reads that number back
 * rather than recomputing it, which is the only way the screen and the score
 * can be guaranteed to agree.
 *
 * There is no calibrate action, and there should not be. The band that grades
 * a run is measured from that run; a button that froze one period's band into
 * the configuration would make every later run be judged against whenever
 * somebody last pressed it.
 */
export function describeChannel(
  key: string,
  ruleSet: RuleSet,
  matches: readonly MatchResult[],
  calibration: RateCalibration | undefined,
): ChannelView {
  const policy = ruleSet.settlementPolicyFor(key);
  const admissible = ruleSet.admissibleFeeBandFor(key);
  const declared = ruleSet.config.channels[key];

  const rates = matches
    .map((match) => match.derivedDeductions?.impliedRate)
    .filter((rate): rate is number => rate !== undefined);

  // A channel whose source states its own deductions has nothing to measure:
  // there is no implied rate because nothing had to be implied.
  const settled = matches.filter((match) => match.right !== null).length;

  return {
    key,
    counterpartyPatterns: [...(declared?.counterpartyPatterns ?? [])],
    cadence: describeCadence(policy),
    ...(policy.cutoff ? { cutoff: `${policy.cutoff.time} ${policy.cutoff.timeZone}` } : {}),
    window: policy.window,
    admissibleBand: admissible,
    declaresOwnBand: declared?.deductions !== undefined,
    reportsOwnDeductions: settled > 0 && rates.length === 0,
    settlements: settled,
    ...(calibration ? { calibration } : {}),
    ...(rates.length > 0
      ? {
          observed: {
            lowest: Math.min(...rates),
            highest: Math.max(...rates),
            count: rates.length,
          },
        }
      : {}),
  };
}

/** Readonly tuples become plain arrays; nothing else changes on the way out. */
export function toChannelDto(channel: ChannelView): ChannelDto {
  return {
    key: channel.key,
    counterpartyPatterns: [...channel.counterpartyPatterns],
    cadence: channel.cadence,
    ...(channel.cutoff ? { cutoff: channel.cutoff } : {}),
    window: { ...channel.window },
    admissibleBand: [channel.admissibleBand[0], channel.admissibleBand[1]],
    declaresOwnBand: channel.declaresOwnBand,
    reportsOwnDeductions: channel.reportsOwnDeductions,
    settlements: channel.settlements,
    ...(channel.calibration
      ? {
          calibration: {
            settlements: channel.calibration.settlements,
            median: channel.calibration.median,
            deviation: channel.calibration.deviation,
            typicalBand: [
              channel.calibration.typicalBand[0],
              channel.calibration.typicalBand[1],
            ] as [number, number],
          },
        }
      : {}),
    ...(channel.observed ? { observed: { ...channel.observed } } : {}),
  };
}
