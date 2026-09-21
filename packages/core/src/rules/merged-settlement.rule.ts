import { Temporal } from '@js-temporal/polyfill';
import { evidence } from '../domain/evidence.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import type { Candidate, MatchingContext, MatchingRule } from './matching-rule.js';
import { eligibleDeposits, describeAmounts } from './settlement-evidence.js';

/**
 * Two batches that the gateway paid in a single transfer.
 *
 * The mirror of the split rule, and the reason this system reported no
 * ambiguity at all across four months — which was the clue that something was
 * missing. Every other outcome is decided by the amount gate, and exactly one
 * credit ever clears it for a given batch, so no two candidates were ever
 * close enough to be called ambiguous. The genuinely undecidable cases were
 * not competing candidates; they were batches whose money had arrived inside
 * somebody else's credit, and they were being filed as "unmatched" as though
 * nothing were known about them.

 *
 * Attributing the credit properly would mean letting one result span several
 * batches, which `MatchResult` cannot express today. Saying so is better than
 * guessing which batch to hand it to.
 */
export class MergedSettlementRule implements MatchingRule {
  readonly id = 'MERGED_SETTLEMENT';
  readonly version = 1;

  evaluate(
    batch: SettlementBatch,
    deposits: readonly Movement[],
    context: MatchingContext,
  ): Candidate[] {
    const neighbours = (context.batches ?? []).filter(
      (other) => other.id !== batch.id && withinDays(other.batchDate, batch.batchDate, 5),
    );
    if (neighbours.length === 0) return [];

    // The window has to be the widest of the group: a credit that settles two
    // batches lands after the later one, which is outside the earlier one's
    // own window.
    const reachable = deposits.filter(
      (deposit) =>
        eligibleDeposits(batch, deposits, context).includes(deposit) ||
        neighbours.some((other) => eligibleDeposits(other, deposits, context).includes(deposit)),
    );

    // Todas las combinaciones que cierran, no la primera que aparezca. Antes
    // se devolvía la primera, así que con dos créditos dentro de la banda la
    // explicación dependía del orden en que llegaban los datos.
    const [low, high] = context.ruleSet.admissibleFeeBandFor(context.channel);
    const fits: Fit[] = [];
    for (const other of neighbours) {
      const combined = batch.gross.plus(other.gross);
      for (const deposit of reachable) {
        const rate = 1 - deposit.amount.cents / combined.cents;
        if (rate >= low && rate <= high) fits.push({ other, deposit, combined, rate });
      }
    }

    const best = fits.sort(closestTo((low + high) / 2))[0];
    return best ? [this.explain(batch, best.other, best.deposit, best.combined, best.rate)] : [];
  }

  private explain(
    batch: SettlementBatch,
    other: SettlementBatch,
    deposit: Movement,
    combined: Money,
    rate: number,
  ): Candidate {
    return {
      deposits: [],
      amounts: describeAmounts(batch, Money.zero()),
      evidence: [
        evidence('SETTLEMENT_MERGED', 'INTEGRITY', false, {
          expected: `una acreditación propia de ${batch.expectedNet.toString()}`,
          observed: `${deposit.valueDate.toString()} ${deposit.amount.toString()}`,
          detail:
            `parece haberse cobrado junto con el corte del ${other.batchDate.toString()}: ` +
            `los dos suman ${combined.toString()} y el crédito está ` +
            `${(rate * 100).toFixed(2).replace('.', ',')}% por debajo, dentro de lo que el ` +
            `canal puede cobrar`,
        }),
      ],
    };
  }
}

interface Fit {
  readonly other: SettlementBatch;
  readonly deposit: Movement;
  readonly combined: Money;
  readonly rate: number;
}

function closestTo(middle: number) {
  return (a: Fit, b: Fit): number =>
    Math.abs(a.rate - middle) - Math.abs(b.rate - middle) ||
    Temporal.PlainDate.compare(a.deposit.valueDate, b.deposit.valueDate) ||
    (a.deposit.id < b.deposit.id ? -1 : a.deposit.id > b.deposit.id ? 1 : 0) ||
    Temporal.PlainDate.compare(a.other.batchDate, b.other.batchDate);
}

function withinDays(a: Temporal.PlainDate, b: Temporal.PlainDate, days: number): boolean {
  return Math.abs(a.since(b).total({ unit: 'days' })) <= days;
}
