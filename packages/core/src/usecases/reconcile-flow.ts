import type { BusinessCalendar } from '../domain/business-calendar.js';
import { evidence } from '../domain/evidence.js';
import { deriveMatchId } from '../domain/identity.js';
import type { AccountId, BatchId, RunId } from '../domain/ids.js';
import type {
  MatchResult,
  MatchStatus,
  ReconciliationReport,
  UnattributedCredit,
} from '../domain/match-result.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { RuleSet } from '../domain/ruleset.js';
import { type SettlementBatch, buildSettlementBatches } from '../domain/settlement-batch.js';
import type { MovementRepository } from '../ports/repositories.js';
import type { DateRange } from '../ports/source-connector.js';
import { type BatchAssignment, assignCandidates } from '../rules/assignment.js';
import type { Candidate, MatchingContext, MatchingRule } from '../rules/matching-rule.js';

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
 * Group the gateway ledger into daily batches, ask each rule which bank
 * credits could settle them, assign across the whole field, and report every
 * batch with the evidence behind its verdict — including the credits nobody
 * claimed. Nothing is left unclassified, because a silent omission is
 * indistinguishable from "there was no activity".
 */
export class ReconcileFlow {
  constructor(
    private readonly movements: MovementRepository,
    private readonly calendar: BusinessCalendar,
    private readonly ruleSet: RuleSet,
    /** Tried in order; the first to produce candidates owns the batch. */
    private readonly rules: readonly MatchingRule[],
  ) {}

  async execute(input: ReconcileFlowInput): Promise<ReconciliationReport> {
    const context: MatchingContext = {
      calendar: this.calendar,
      ruleSet: this.ruleSet,
      channel: input.channel,
    };

    const gatewayMovements = await this.movements.findByAccount(
      input.gatewayAccountId,
      input.range,
    );
    // The bank side runs past the requested window: a batch dated on the last
    // day settles after it, and cutting there would report a false gap.
    const bankMovements = await this.movements.findByAccount(input.bankAccountId, {
      from: input.range.from,
      to: this.calendar.nextBusinessDay(
        input.range.to,
        this.ruleSet.config.settlementWindow.toBusinessDays,
      ),
    });

    const batches = buildSettlementBatches({
      accountId: input.gatewayAccountId,
      movements: gatewayMovements,
    });

    const candidatesByBatch = new Map<BatchId, readonly Candidate[]>();
    for (const batch of batches) {
      candidatesByBatch.set(batch.id, this.candidatesFor(batch, bankMovements, context));
    }

    const assignments = assignCandidates(batches, candidatesByBatch, this.ruleSet);
    const matches = assignments.map((assignment) => this.toMatchResult(assignment, input));

    return {
      ...(input.runId ? { runId: input.runId } : {}),
      rulesetVersion: this.ruleSet.version,
      matches,
      unattributed: this.unattributedCredits(bankMovements, matches, input.channel),
      totals: summarise(matches, batches),
    };
  }

  private candidatesFor(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): readonly Candidate[] {
    for (const rule of this.rules) {
      const candidates = rule.evaluate(batch, deposits, context);
      if (candidates.length > 0) return candidates;
    }
    return [];
  }

  private toMatchResult(assignment: BatchAssignment, input: ReconcileFlowInput): MatchResult {
    const { batch, winner, confidence, alternatives } = assignment;
    const { fromBusinessDays, toBusinessDays } = this.ruleSet.config.settlementWindow;
    const window = this.calendar.settlementWindow(
      batch.batchDate,
      fromBusinessDays,
      toBusinessDays,
    );
    const rule = this.rules[0];

    return {
      id: deriveMatchId(batch.id, winner?.deposit.id),
      ...(input.runId ? { runId: input.runId } : {}),
      rulesetVersion: this.ruleSet.version,
      kind: 'CHANNEL_TO_BANK',
      status: winner ? (confidence.band as MatchStatus) : 'UNMATCHED',
      left: { batchId: batch.id, batchDate: batch.batchDate, chargeIds: batch.chargeIds },
      right: winner ? { movementId: winner.deposit.id } : null,
      rule: { id: rule?.id ?? 'NONE', version: rule?.version ?? 0 },
      amounts: winner?.amounts ?? {
        gross: batch.gross,
        deductions: batch.gross.minus(batch.expectedNet),
        expectedNet: batch.expectedNet,
      },
      window: { from: window.from, to: window.to, basis: 'BUSINESS_DAYS' },
      confidence,
      alternatives,
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
    const claimed = new Set(matches.map((match) => match.right?.movementId).filter(Boolean));

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

function summarise(
  matches: readonly MatchResult[],
  batches: readonly SettlementBatch[],
): ReconciliationReport['totals'] {
  const byStatus: Partial<Record<MatchStatus, number>> = {};
  for (const match of matches) {
    byStatus[match.status] = (byStatus[match.status] ?? 0) + 1;
  }

  const expectedNet = Money.sum(batches.map((batch) => batch.expectedNet));
  const observedNet = Money.sum(
    matches.map((match) => match.amounts.observedNet ?? Money.zero()),
  );

  return {
    batches: batches.length,
    byStatus,
    expectedNet,
    observedNet,
    unexplained: expectedNet.minus(observedNet),
  };
}
