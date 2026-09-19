import type { Temporal } from '@js-temporal/polyfill';
import { sha256 } from './identity.js';
import { type AccountId, type BatchId, type MovementId, batchId } from './ids.js';
import { Money } from './money.js';
import type { Movement, MovementType } from './movement.js';
import { DAILY_T1, type SettlementPolicy, closingDateFor } from './settlement-policy.js';

/**
 * A settlement batch: the charges a gateway collected in one cutoff period,
 * what it netted out, and what it therefore owes the bank.
 *
 * This is the join node of the whole reconciliation. Without it, matching N
 * payments to M deposits is a subset-sum problem — expensive, ambiguous and,
 * worse, badly explainable. With it, Phase 2 is a 1:1 comparison between a
 * computed expectation and an observed credit, and "the 31 Dec batch settled
 * on 2 Jan, T+1 because the 1st was a holiday" is an explanation a CFO can
 * check. Combinatorics stays as the fallback. See ADR-0004.
 */

export type DeductionKind = Extract<MovementType, 'FEE' | 'TAX' | 'WITHHOLDING'>;

export const DEDUCTION_KINDS: readonly DeductionKind[] = ['FEE', 'TAX', 'WITHHOLDING'];

/**
 * EXPLICIT: the source reported the amount. Wompi does, per transaction.
 * IMPLIED:  we inferred it from the gap against the credit, and the evidence
 *           says so — an inferred deduction is weaker ground than a reported one.
 */
export type DeductionBasis = 'EXPLICIT' | 'IMPLIED';

export interface Deduction {
  readonly kind: DeductionKind;
  /** Positive magnitude. The sign lives in the ledger, not here. */
  readonly amount: Money;
  readonly basis: DeductionBasis;
  readonly movementIds: readonly MovementId[];
}

export interface SettlementBatch {
  readonly id: BatchId;
  readonly accountId: AccountId;
  readonly batchDate: Temporal.PlainDate;
  readonly chargeIds: readonly MovementId[];
  /** Sum of collections, net of refunds and chargebacks. */
  readonly gross: Money;
  readonly deductions: readonly Deduction[];
  /** gross − deductions: what we expect to see land in the bank. */
  readonly expectedNet: Money;
}

export function deriveBatchId(accountId: AccountId, date: Temporal.PlainDate): BatchId {
  return batchId(`bat_${sha256(`${accountId}|${date.toString()}`).slice(0, 16)}`);
}

/**
 * Groups a gateway ledger into batches, one per cutoff period.
 *
 * The period comes from the channel's policy, not from this function: daily
 * for Wompi, which is what the brief describes, but a channel that cuts
 * weekly groups a week of charges into one batch with no change here. The
 * cutoff within a day is assumed to be midnight in the business timezone
 * (Q2.1); were it hourly, late payments would belong to the next batch —
 * detectable as a day that misses by exactly its last transactions, and
 * fixable by passing a different `batchDateOf`.
 */
export function buildSettlementBatches(input: {
  readonly accountId: AccountId;
  readonly movements: readonly Movement[];
  readonly policy?: SettlementPolicy;
  readonly batchDateOf?: (movement: Movement) => Temporal.PlainDate;
}): SettlementBatch[] {
  const policy = input.policy ?? DAILY_T1;
  const batchDateOf =
    input.batchDateOf ?? ((movement: Movement) => closingDateFor(movement.valueDate, policy));
  const byDate = new Map<string, Movement[]>();

  for (const movement of input.movements) {
    if (movement.accountId !== input.accountId) continue;
    if (!isBatchable(movement.type)) continue;
    const key = batchDateOf(movement).toString();
    const bucket = byDate.get(key);
    if (bucket) bucket.push(movement);
    else byDate.set(key, [movement]);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, movements]) => assembleBatch(input.accountId, batchDateOf(movements[0]!), movements));
}

function assembleBatch(
  accountId: AccountId,
  batchDate: Temporal.PlainDate,
  movements: readonly Movement[],
): SettlementBatch {
  const charges = movements.filter((m) => m.type === 'CHARGE');
  const reversals = movements.filter((m) => m.type === 'REFUND' || m.type === 'CHARGEBACK');

  const gross = Money.sum([...charges, ...reversals].map((m) => m.amount));

  const deductions = DEDUCTION_KINDS.flatMap<Deduction>((kind) => {
    const parts = movements.filter((m) => m.type === kind);
    if (parts.length === 0) return [];
    return [
      {
        kind,
        amount: Money.sum(parts.map((m) => m.amount)).abs(),
        basis: 'EXPLICIT',
        movementIds: parts.map((m) => m.id),
      },
    ];
  });

  return {
    id: deriveBatchId(accountId, batchDate),
    accountId,
    batchDate,
    chargeIds: charges.map((m) => m.id),
    gross,
    deductions,
    expectedNet: gross.minus(totalDeductions(deductions)),
  };
}

export function totalDeductions(deductions: readonly Deduction[]): Money {
  return Money.sum(deductions.map((d) => d.amount));
}

/**
 * `gross = net + fee + VAT + withholding`, within tolerance.
 *
 * The same identity the ERP entry has to balance on in Phase 3, which is why
 * it is worth checking here: if it does not hold, we misread the source, and
 * everything downstream would be built on that.
 */
export function identityHolds(batch: SettlementBatch, toleranceCents = 1): boolean {
  const recomposed = batch.expectedNet.plus(totalDeductions(batch.deductions));
  return Math.abs(recomposed.minus(batch.gross).cents) <= toleranceCents;
}

function isBatchable(type: MovementType): boolean {
  return (
    type === 'CHARGE' ||
    type === 'REFUND' ||
    type === 'CHARGEBACK' ||
    (DEDUCTION_KINDS as readonly MovementType[]).includes(type)
  );
}
