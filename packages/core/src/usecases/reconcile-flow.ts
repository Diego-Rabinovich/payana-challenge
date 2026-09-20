import type { BusinessCalendar } from '../domain/business-calendar.js';
import { type DeductionRates, deriveDeductions } from '../domain/deduction-model.js';
import { type Evidence, evidence } from '../domain/evidence.js';
import { scoreMatch } from '../domain/confidence.js';
import { deriveMatchId } from '../domain/identity.js';
import type { AccountId, BatchId, RunId } from '../domain/ids.js';
import type {
  DerivedDeductions,
  MatchResult,
  MatchStatus,
  ReconciliationReport,
  UnattributedCredit,
} from '../domain/match-result.js';
import { Money } from '../domain/money.js';
import {
  type RateCalibration,
  calibrateRates,
  isTypical,
} from '../domain/rate-calibration.js';
import type { Movement } from '../domain/movement.js';
import type { RuleSet } from '../domain/ruleset.js';
import { type SettlementBatch, buildSettlementBatches } from '../domain/settlement-batch.js';
import type { SettlementPolicy } from '../domain/settlement-policy.js';
import type { MovementRepository } from '../ports/repositories.js';
import type { DateRange } from '../ports/source-connector.js';
import { type BatchAssignment, assignCandidates } from '../rules/assignment.js';
import {
  type Candidate,
  type MatchingContext,
  type MatchingRule,
  candidateKey,
  depositIdsOf,
} from '../rules/matching-rule.js';

export interface ReconcileFlowOptions {
  /**
   * Overrides the rates a gap is split with. Normally left unset: the rates
   * come from the channel's own entry in the ruleset, so a gateway in another
   * jurisdiction is configuration rather than a constructor argument.
   */
  readonly rates?: DeductionRates;
}

export interface ReconcileFlowInput {
  readonly gatewayAccountId: AccountId;
  readonly bankAccountId: AccountId;
  /** Which channel we are reconciling, as keyed in the ruleset. */
  readonly channel: string;
  readonly range: DateRange;
  readonly runId?: RunId;
}

/**
 * Phase 2: did the money the channel promised actually reach the bank?
 *
 * Group the gateway ledger into batches on the channel's own cadence, ask
 * every rule which bank credits could settle them, assign across the whole
 * field, and report every batch with the evidence behind its verdict —
 * including the credits nobody claimed. Nothing is left unclassified, because
 * a silent omission is indistinguishable from "there was no activity".
 */
export class ReconcileFlow {
  constructor(
    private readonly movements: MovementRepository,
    private readonly calendar: BusinessCalendar,
    private readonly ruleSet: RuleSet,
    /**
     * All of them run. Rules find; they do not judge, and none of them may
     * veto another by going first — which credit settles which batch is a
     * property of the whole field, so it is decided once, downstream.
     */
    private readonly rules: readonly MatchingRule[],
    private readonly options: ReconcileFlowOptions = {},
  ) {}

  async execute(input: ReconcileFlowInput): Promise<ReconciliationReport> {
    const policy = this.ruleSet.settlementPolicyFor(input.channel);
    const context: MatchingContext = {
      calendar: this.calendar,
      ruleSet: this.ruleSet,
      channel: input.channel,
      policy,
    };

    const gatewayMovements = await this.movements.findByAccount(
      input.gatewayAccountId,
      input.range,
    );
    // The bank side runs past the requested window: a batch dated on the last
    // day settles after it, and cutting there would report a false gap.
    const bankMovements = await this.movements.findByAccount(input.bankAccountId, {
      from: input.range.from,
      to: this.calendar.nextBusinessDay(input.range.to, policy.window.toBusinessDays),
    });

    const batches = buildSettlementBatches({
      accountId: input.gatewayAccountId,
      movements: gatewayMovements,
      calendar: this.calendar,
      policy,
    });

    // The whole field, so a rule that reasons across batches can see it.
    const withBatches: MatchingContext = { ...context, batches };

    const candidatesByBatch = new Map<BatchId, readonly Candidate[]>();
    for (const batch of batches) {
      candidatesByBatch.set(batch.id, this.candidatesFor(batch, bankMovements, withBatches));
    }

    const assignments = assignCandidates(batches, candidatesByBatch, this.ruleSet);
    const provisional = assignments.map((assignment) =>
      this.toMatchResult(assignment, input, policy),
    );

    // Second pass. Matching is finished and nothing below can change it:
    // what the channel usually charges is measured over the settlements
    // that matched, and the ones sitting on that rate are credited for it.
    // Only points move, which is what keeps using the run's own data here
    // from being circular. See rate-calibration.ts.
    const calibration = calibrateRates(
      provisional
        .filter((match) => match.right !== null)
        .map((match) => match.derivedDeductions?.impliedRate)
        .filter((rate): rate is number => rate !== undefined),
    );
    const matches = provisional.map((match) => this.creditTypical(match, calibration));

    return {
      ...(input.runId ? { runId: input.runId } : {}),
      rulesetVersion: this.ruleSet.version,
      matches,
      unattributed: this.unattributedCredits(bankMovements, matches, input.channel),
      totals: summarise(matches, batches),
      ...(calibration ? { calibration } : {}),
    };
  }

  /**
   * Every rule's proposals, deduplicated by the set of credits they claim.
   *
   * It used to stop at the first rule that produced anything, which quietly
   * made rule order a ranking: a weak single-credit candidate would hide a
   * perfect split behind it. Ranking belongs to the score, which can see all
   * the evidence, so every proposal goes forward and the assignment decides.
   */
  private candidatesFor(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): readonly Candidate[] {
    const seen = new Map<string, Candidate>();
    for (const rule of this.rules) {
      for (const candidate of rule.evaluate(batch, deposits, context)) {
        const key = candidateKey(candidate);
        if (!seen.has(key)) seen.set(key, candidate);
      }
    }
    return [...seen.values()];
  }

  private toMatchResult(
    assignment: BatchAssignment,
    input: ReconcileFlowInput,
    policy: SettlementPolicy,
  ): MatchResult {
    const { batch, winner, confidence, alternatives } = assignment;
    const { fromBusinessDays, toBusinessDays } = policy.window;
    const window = this.calendar.settlementWindow(
      batch.batchDate,
      fromBusinessDays,
      toBusinessDays,
    );
    const rule = this.ruleThatFound(winner);
    const derived = winner
      ? this.derive(batch, winner.amounts.observedNet, input.channel)
      : undefined;

    return {
      id: deriveMatchId(batch.id, winner ? candidateKey(winner) : undefined),
      ...(input.runId ? { runId: input.runId } : {}),
      rulesetVersion: this.ruleSet.version,
      kind: 'CHANNEL_TO_BANK',
      status: winner ? (confidence.band as MatchStatus) : 'UNMATCHED',
      left: { batchId: batch.id, batchDate: batch.batchDate, chargeIds: batch.chargeIds },
      right: winner ? { movementIds: depositIdsOf(winner) } : null,
      rule: { id: rule?.id ?? 'NONE', version: rule?.version ?? 0 },
      amounts: winner?.amounts ?? {
        gross: batch.gross,
        deductions: batch.gross.minus(batch.expectedNet),
        expectedNet: batch.expectedNet,
      },
      window: { from: window.from, to: window.to, basis: 'BUSINESS_DAYS' },
      confidence: derived ? withDerivationEvidence(confidence, derived) : confidence,
      ...(derived ? { derivedDeductions: derived } : {}),
      alternatives,
    };
  }

  /**
   * Awards the points a settlement earns for sitting on the usual rate.
   *
   * Strictly additive: it can turn IMPLIED_FEE_IN_BAND into
   * IMPLIED_FEE_TYPICAL and re-score, and it can do nothing else. A match
   * cannot be made or unmade here, a band cannot reject anything, and a
   * settlement outside the usual rate keeps every point it had.
   */
  private creditTypical(match: MatchResult, calibration: RateCalibration | undefined): MatchResult {
    const rate = match.derivedDeductions?.impliedRate;
    if (match.right === null || rate === undefined) return match;
    if (!isTypical(rate, calibration)) return match;

    const [low, high] = calibration!.typicalBand;
    const upgraded = match.confidence.components.map((item) =>
      item.code === 'IMPLIED_FEE_IN_BAND'
        ? {
            ...item,
            code: 'IMPLIED_FEE_TYPICAL' as const,
            expected: `${percent(low)}–${percent(high)} · lo habitual en esta corrida`,
            detail: 'la diferencia coincide con lo que este canal cobró en el resto del período',
          }
        : item,
    );
    if (upgraded === match.confidence.components) return match;

    const contested = match.status === 'AMBIGUOUS';
    const confidence = scoreMatch(upgraded, this.ruleSet.scoring, { contested });

    return {
      ...match,
      confidence,
      status: confidence.band as MatchStatus,
    };
  }

  /**
   * Which rule to credit for a match. A split settlement is the split rule's
   * finding even when the scheduled rule also had an opinion, so the report
   * names the route actually taken rather than the first rule configured.
   */
  private ruleThatFound(winner: Candidate | undefined): MatchingRule | undefined {
    if (!winner) return this.rules[0];
    const split = winner.deposits.length > 1;
    return (
      this.rules.find((rule) =>
        split ? rule.id === 'SPLIT_SETTLEMENT' : rule.id !== 'SPLIT_SETTLEMENT',
      ) ?? this.rules[0]
    );
  }

  /**
   * Recovers the breakdown the gateway never sent.
   *
   * Only when it sent none: a reported breakdown is stronger evidence than a
   * computed one, and overwriting it would throw that away. The result stays
   * out of `amounts.expectedNet` so that "expected equals observed" can never
   * become true by construction — the whole point of the confidence score is
   * that it measures how much we know. See ADR-0013.
   */
  private derive(
    batch: SettlementBatch,
    observedNet: Money | undefined,
    channel: string,
  ): DerivedDeductions | undefined {
    if (batch.deductions.length > 0 || !observedNet) return undefined;

    const derivation = deriveDeductions(
      batch.gross,
      observedNet,
      batch.chargeIds.length,
      this.options.rates ?? this.ruleSet.deductionRatesFor(channel),
    );
    const amountOf = (kind: string) =>
      derivation.deductions.find((deduction) => deduction.kind === kind)?.amount;

    const fee = amountOf('FEE');
    const tax = amountOf('TAX');
    const withholding = amountOf('WITHHOLDING');
    if (!fee || !tax || !withholding) return undefined;

    return {
      fee,
      tax,
      withholding,
      total: derivation.total,
      impliedRate: derivation.impliedRate,
      consistent: derivation.consistent,
    };
  }

  /**
   * Credits no batch claimed. Interest, an unrelated transfer, a payer we do
   * not track — none of it is an error, and all of it is something the CFO
   * needs to see rather than have quietly filtered away.
   */
  private unattributedCredits(
    bankMovements: readonly Movement[],
    matches: readonly MatchResult[],
    channel: string,
  ): UnattributedCredit[] {
    const claimed = new Set(matches.flatMap((match) => match.right?.movementIds ?? []));

    return bankMovements
      .filter((movement) => movement.amount.isPositive() && !claimed.has(movement.id))
      .map((movement) => ({
        movementId: movement.id,
        valueDate: movement.valueDate,
        amount: movement.amount,
        ...(movement.counterparty ? { counterparty: movement.counterparty } : {}),
        description: movement.description,
        reason: this.ruleSet.isChannelCounterparty(channel, movement.counterparty)
          ? evidence('AMOUNT_MISMATCH', 'AMOUNT', false).code
          : evidence('DESCRIPTOR_FOREIGN', 'DESCRIPTOR', false).code,
      }));
  }
}

/** The derivation is a claim about the money, so it travels as evidence. */
function withDerivationEvidence(confidence: MatchResult['confidence'], derived: DerivedDeductions) {
  const note: Evidence = evidence('DEDUCTIONS_DERIVED', 'AMOUNT', derived.consistent, {
    expected: 'desglose informado por la fuente',
    observed: `derivado de la diferencia · ${(derived.impliedRate * 100).toFixed(2).replace('.', ',')}% del bruto`,
    detail: `comisión ${derived.fee.toString()} · IVA ${derived.tax.toString()} · retención ${derived.withholding.toString()}`,
  });
  return { ...confidence, components: [...confidence.components, note] };
}

function summarise(
  matches: readonly MatchResult[],
  batches: readonly SettlementBatch[],
): ReconciliationReport['totals'] {
  const byStatus: Partial<Record<MatchStatus, number>> = {};
  for (const match of matches) {
    byStatus[match.status] = (byStatus[match.status] ?? 0) + 1;
  }

  const gross = Money.sum(batches.map((batch) => batch.gross));
  const reported = Money.sum(batches.map((batch) => batch.gross.minus(batch.expectedNet)));
  const derived = Money.sum(
    matches.map((match) => match.derivedDeductions?.total ?? Money.zero()),
  );

  // Reported where the source gave it, derived where it did not. Showing zero
  // because the gateway is silent turned a commission into a hole in the
  // funnel, which is the first thing a CFO reads.
  const deductions = reported.isZero() ? derived : reported;
  const expectedNet = gross.minus(deductions);
  const observedNet = Money.sum(
    matches.map((match) => match.amounts.observedNet ?? Money.zero()),
  );

  return {
    batches: batches.length,
    byStatus,
    gross,
    deductions,
    deductionsAreDerived: reported.isZero() && !derived.isZero(),
    expectedNet,
    observedNet,
    unexplained: expectedNet.minus(observedNet),
  };
}

/** Rates read as percentages everywhere a person sees them. */
function percent(value: number): string {
  return `${(value * 100).toFixed(2).replace('.', ',')}%`;
}
