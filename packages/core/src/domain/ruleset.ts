import type { ScoringConfig } from './confidence.js';
import { COLOMBIAN_RATES, type DeductionRates } from './deduction-model.js';
import { ConfigurationError } from './errors.js';
import {
  DAILY_T1,
  type SettlementPolicy,
  type SettlementWindow,
  assertPolicy,
} from './settlement-policy.js';

/**
 * The versioned rules the reconciliation runs under.
 *
 * Every threshold lives here rather than in code, so changing a tolerance is
 * editing JSON, not shipping a release. The version travels in every result:
 * without it, a result cannot be reproduced, and a number nobody can reproduce
 * has no place in an audit. See ADR-0005.
 *
 * Loading the JSON is an adapter's job. This takes a plain object and checks
 * it, so `core` stays free of file systems.
 */
export interface RuleSetConfig extends ScoringConfig {
  readonly version: string;
  /** The window a channel gets when it declares no settlement policy of its own. */
  readonly settlementWindow: SettlementWindow;
  readonly tolerances: {
    /** How far a credit may differ and still count as the same money. */
    readonly roundingCents: number;
    /** Slack on `gross = net + deductions`; truncation accumulates a little. */
    readonly identityCents: number;
    /** Plausible total deduction rate when the source did not report one. */
    readonly impliedFeeRateBand: readonly [number, number];
  };
  readonly subsetSum: {
    readonly maxSubsetSize: number;
    readonly maxSolutions: number;
    readonly toleranceCents: number;
    /** Search budget. Exceeding it is reported, not silently truncated. */
    readonly maxNodes: number;
  };
  /**
   * How a channel identifies itself on a bank statement.
   *
   * Reconciliation policy, not an ingestion fact: the parser records the
   * counterparty a descriptor names, and this decides whether that name is
   * the channel we were expecting. Keeping the two apart is what stops the
   * confidence score from scoring a conclusion ingestion already reached.
   */
  readonly channels: Readonly<Record<string, ChannelConfig>>;
}

export interface ChannelConfig {
  readonly counterpartyPatterns: readonly string[];
  /**
   * How this channel batches and how long it then takes. Absent means the
   * default: daily cutoff on the global window, which is Wompi's behaviour
   * and what the brief describes.
   */
  readonly settlement?: SettlementPolicy;
  /**
   * The rates this channel's deductions are derived with. Absent means the
   * Colombian statutory rates. A gateway in another jurisdiction, or one that
   * reports its own fees, overrides here rather than in code.
   */
  readonly deductions?: DeductionRates;
}

export class RuleSet {
  private constructor(readonly config: RuleSetConfig) {}

  static from(config: RuleSetConfig): RuleSet {
    if (!config.version) {
      throw new ConfigurationError('Ruleset has no version; results would not be reproducible', {});
    }
    const { fromBusinessDays, toBusinessDays } = config.settlementWindow;
    if (fromBusinessDays < 1 || toBusinessDays < fromBusinessDays) {
      throw new ConfigurationError('Settlement window is empty or inverted', {
        fromBusinessDays,
        toBusinessDays,
      });
    }
    const [low, high] = config.tolerances.impliedFeeRateBand;
    if (low < 0 || high < low) {
      throw new ConfigurationError('Implied fee band is inverted', { low, high });
    }
    // Checked at load, not at first use: a malformed channel should fail the
    // run that loaded it, not the reconciliation that happens to reach it.
    for (const [channel, declared] of Object.entries(config.channels)) {
      if (declared.settlement) assertPolicy(declared.settlement, channel);
    }
    return new RuleSet(config);
  }

  get version(): string {
    return this.config.version;
  }

  get scoring(): ScoringConfig {
    return this.config;
  }

  get channelKeys(): readonly string[] {
    return Object.keys(this.config.channels);
  }

  /**
   * How the channel batches. A channel that says nothing gets the daily cut
   * on the global window, so existing configurations keep behaving exactly
   * as they did.
   */
  settlementPolicyFor(channel: string): SettlementPolicy {
    const declared = this.config.channels[channel]?.settlement;
    if (!declared) return { ...DAILY_T1, window: this.config.settlementWindow };
    return assertPolicy(declared, channel);
  }

  /** The rates this channel's deductions are derived with. */
  deductionRatesFor(channel: string): DeductionRates {
    return this.config.channels[channel]?.deductions ?? COLOMBIAN_RATES;
  }

  /** True when `counterparty` is the channel we expected to hear from. */
  isChannelCounterparty(channel: string, counterparty: string | undefined): boolean {
    if (counterparty === undefined) return false;
    const patterns = this.config.channels[channel]?.counterpartyPatterns ?? [];
    const haystack = counterparty.toUpperCase();
    return patterns.some((pattern) => haystack.includes(pattern.toUpperCase()));
  }

  /** True when the counterparty is recognisably someone else's. */
  isForeignCounterparty(channel: string, counterparty: string | undefined): boolean {
    if (counterparty === undefined) return false;
    if (this.isChannelCounterparty(channel, counterparty)) return false;
    return Object.keys(this.config.channels).some((other) =>
      other === channel ? false : this.isChannelCounterparty(other, counterparty),
    );
  }
}
