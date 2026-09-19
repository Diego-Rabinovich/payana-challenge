import type { Temporal } from '@js-temporal/polyfill';
import type { BatchId, MatchId, MovementId } from '../domain/ids.js';
import type { MatchResult } from '../domain/match-result.js';
import { Money } from '../domain/money.js';
import type { Movement } from '../domain/movement.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';

/**
 * Where one payment's money ended up.
 *
 * The brief asks this literally: if I look at the individual $100 payment,
 * did its funds — net of fees and taxes — end up inside that +$440 credit?
 * Answering it needs an attribution rule, because the bank never saw the $100
 * on its own. We allocate the batch's net across its charges in proportion to
 * their gross, by largest remainder, so the attributed amounts sum exactly to
 * what the bank received. See ADR-0008.
 */

export interface LineageStep {
  readonly stage: 'CHARGE' | 'BATCH' | 'SETTLEMENT' | 'BANK_CREDIT';
  readonly ref: MovementId | BatchId | MatchId;
  readonly date: Temporal.PlainDate;
  readonly amount: Money;
  readonly detail: string;
}

export interface Lineage {
  readonly movementId: MovementId;
  readonly gross: Money;
  /** This charge's share of the batch net, by pro-rata allocation. */
  readonly attributedNet: Money;
  readonly batchId: BatchId;
  readonly matchId?: MatchId;
  readonly bankCreditId?: MovementId;
  readonly steps: readonly LineageStep[];
  /** Absent when the batch never matched a credit. */
  readonly settled: boolean;
}

export interface TraceInput {
  readonly charge: Movement;
  readonly batch: SettlementBatch;
  readonly charges: readonly Movement[];
  readonly match?: MatchResult;
  readonly bankCredit?: Movement;
}

export function traceMovement(input: TraceInput): Lineage {
  const { charge, batch, charges, match, bankCredit } = input;

  // Against what actually landed where we know it, and against the expectation
  // only when nothing did. Attributing the expected net was the reason this
  // screen kept showing a charge's share as identical to its gross: Wompi
  // reports no deductions, so the expected net *is* the gross, and the
  // proportion of a number by itself is that number.
  const settledTotal = match?.amounts?.observedNet ?? batch.expectedNet;
  const attributedNet = attribute(charge, settledTotal, charges);
  const steps: LineageStep[] = [
    {
      stage: 'CHARGE',
      ref: charge.id,
      date: charge.valueDate,
      amount: charge.amount,
      detail: 'Pago aprobado en la pasarela',
    },
    {
      stage: 'BATCH',
      ref: batch.id,
      date: batch.batchDate,
      amount: batch.gross,
      detail:
        charges.length === 1
          ? 'Un solo pago en este corte'
          : `${charges.length} pagos liquidados juntos`,
    },
    {
      stage: 'SETTLEMENT',
      ref: batch.id,
      date: batch.batchDate,
      amount: settledTotal,
      detail:
        match?.amounts?.observedNet !== undefined
          ? 'Neto girado, ya descontadas las comisiones'
          : 'Neto esperado; la fuente no informó deducciones',
    },
  ];

  if (match && bankCredit) {
    steps.push({
      stage: 'BANK_CREDIT',
      ref: bankCredit.id,
      date: bankCredit.valueDate,
      amount: bankCredit.amount,
      detail: `Acreditado en el banco el ${bankCredit.valueDate.toString()}`,
    });
  }

  return {
    movementId: charge.id,
    gross: charge.amount,
    attributedNet,
    batchId: batch.id,
    ...(match ? { matchId: match.id } : {}),
    ...(bankCredit ? { bankCreditId: bankCredit.id } : {}),
    steps,
    settled: Boolean(match && bankCredit),
  };
}

/**
 * This charge's slice of a settled total.
 *
 * Allocating the whole amount at once, rather than computing each share
 * independently, is what guarantees the shares add back up to it: rounding each
 * one on its own would lose or invent cents at scale.
 */
export function attribute(
  charge: Movement,
  total: Money,
  charges: readonly Movement[],
): Money {
  const ordered = [...charges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = ordered.findIndex((candidate) => candidate.id === charge.id);
  if (index === -1) return Money.zero();

  const weights = ordered.map((item) => Math.abs(item.amount.cents));
  if (weights.every((weight) => weight === 0)) return Money.zero();

  return total.allocate(weights)[index] ?? Money.zero();
}
