import { evidence } from '../domain/evidence.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import { findSubsets } from '../domain/subset-sum.js';
import type { Candidate, MatchingContext, MatchingRule } from './matching-rule.js';
import {
  amountEvidence,
  dateEvidence,
  descriptorEvidence,
  describeAmounts,
  eligibleDeposits,
  expectedTotal,
  identityEvidence,
} from './settlement-evidence.js';

/**
 * The fallback: a batch that arrived split across several credits.
 *
 * It exists because the relation is genuinely N:M and pretending otherwise
 * was costing real matches — a batch paid as two transfers on the same day
 * was reported unmatched, and the two credits were reported unattributed,
 * which is three findings where there is one fact.
 *
 * It stays subordinate to the scheduled rule in two ways that matter. It only
 * proposes subsets of two or more, so it never competes for the single-credit
 * case the brief describes. And every candidate it produces carries
 * `SETTLEMENT_SPLIT`, a failed check: the arithmetic may be perfect, but the
 * money did not arrive the way it was supposed to, and that is a fact about
 * the settlement rather than a defect of the search. Failing it caps the
 * score below CONFIRMED, so a split always reads as "we believe this, and
 * here is what was unusual about it". See ADR-0004.
 */
export class SplitSettlementRule implements MatchingRule {
  readonly id = 'SPLIT_SETTLEMENT';
  readonly version = 1;

  evaluate(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): Candidate[] {
    const eligible = eligibleDeposits(batch, deposits, context);
    if (eligible.length < 2) return [];

    const { subsetSum } = context.ruleSet.config;
    // The same target the scheduled rule would accept a single credit against,
    // so the two rules cannot disagree about what "the right amount" means.
    const { targetCents, toleranceCents } = expectedTotal(batch, context.ruleSet, context.channel);
    const result = findSubsets(
      eligible.map((deposit) => deposit.amount.cents),
      {
        targetCents,
        toleranceCents,
        maxSubsetSize: subsetSum.maxSubsetSize,
        maxSolutions: subsetSum.maxSolutions,
        maxNodes: subsetSum.maxNodes,
      },
    );

    if (result.budgetExceeded && result.solutions.length === 0) {
      // Reported, not hidden: claiming no combination exists when the search
      // stopped early would be the one dishonest outcome available here.
      return [this.exhausted(batch, eligible, result.nodesVisited)];
    }

    const viable = result.solutions.filter((indices) => indices.length > 1);

    // Several different subsets adding to the same target is the ambiguity the
    // brief warns about, and it is a property of the set of solutions rather
    // than of any one of them. Every candidate carries it, so whichever one
    // the assignment picks still says out loud that others existed.
    return viable.map((indices) =>
      this.assess(batch, indices.map((index) => eligible[index]!), context, viable.length),
    );
  }

  private assess(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    { calendar, ruleSet, channel, policy }: MatchingContext,
    solutions = 1,
  ): Candidate {
    const total = Money.sum(deposits.map((deposit) => deposit.amount));
    const amounts = describeAmounts(batch, total);

    return {
      deposits,
      amounts,
      evidence: [
        amountEvidence(batch, amounts, ruleSet, channel),
        dateEvidence(batch, deposits, calendar, policy),
        descriptorEvidence(deposits, ruleSet, channel),
        identityEvidence(batch, ruleSet),
        evidence('SETTLEMENT_SPLIT', 'INTEGRITY', false, {
          expected: '1 acreditación',
          observed: `${deposits.length} acreditaciones`,
          detail: deposits
            .map((deposit) => `${deposit.valueDate.toString()} ${deposit.amount.toString()}`)
            .join(' + '),
        }),
        ...(solutions > 1
          ? [
              evidence('SUBSET_SUM_MULTIPLE', 'AMOUNT', false, {
                expected: 'una sola combinación posible',
                observed: `${solutions} combinaciones distintas suman lo mismo`,
                detail:
                  'la aritmética no alcanza para elegir entre ellas; hace falta mirar el extracto',
              }),
            ]
          : []),
      ],
    };
  }

  /**
   * No candidate, but the reason the search stopped is itself the finding.
   * Carries no deposits, so it can never win an assignment — it exists to put
   * the exhausted budget in the report instead of a silent "unmatched".
   */
  private exhausted(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    nodesVisited: number,
  ): Candidate {
    return {
      deposits: [],
      amounts: describeAmounts(batch, Money.zero()),
      evidence: [
        evidence('UNRESOLVED_COMBINATORIAL', 'AMOUNT', false, {
          expected: batch.expectedNet.toString(),
          observed: `${deposits.length} créditos en la ventana`,
          detail: `búsqueda detenida tras ${nodesVisited} nodos`,
        }),
      ],
    };
  }
}
