import type { ScoringConfig } from './confidence.js';
import { ConfigurationError } from './errors.js';

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
  readonly settlementWindow: {
    readonly fromBusinessDays: number;
    readonly toBusinessDays: number;
  };
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
  readonly channels: Readonly<Record<string, { readonly counterpartyPatterns: readonly string[] }>>;
}

export class RuleSet {
  private constructor(readonly config: RuleSetConfig) {}

  static from(config: RuleSetConfig): RuleSet {
    if (!config.version) {
      throw new ConfigurationError('Ruleset has no version; results would not be reproducible', {});
    }
    const { fromBusinessDays, toBusinessDays } = config.settlementWindow;
    if (fromBusinessDays < 1 || toBusinessDays < fromBusinessDays) {
      throw new ConfigurationError('Settlement window is empty or inverted', config.settlementWindow);
    }
    const [low, high] = config.tolerances.impliedFeeRateBand;
    if (low < 0 || high < low) {
      throw new ConfigurationError('Implied fee band is inverted', { low, high });
    }
    return new RuleSet(config);
  }

  get version(): string {
    return this.config.version;
  }

  get scoring(): ScoringConfig {
    return this.config;
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
