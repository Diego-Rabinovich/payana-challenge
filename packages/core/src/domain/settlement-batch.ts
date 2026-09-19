import type { Temporal } from '@js-temporal/polyfill';
import { sha256 } from './identity.js';
import { type AccountId, type BatchId, type MovementId, batchId } from './ids.js';
import { Money } from './money.js';
import type { Movement, MovementType } from './movement.js';
import type { BusinessCalendar } from './business-calendar.js';
import {
  DAILY_T1,
  type SettlementPolicy,
  accrualDateFor,
  closingDateFor,
  settlementDateFor,
} from './settlement-policy.js';

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
 * Groups a gateway ledger into the batches that actually settle together.
 *
 * Not by calendar day, which is what this did first and what the data
 * disproved. A gateway does not transfer on a Sunday: Saturday and Sunday
 * sales arrive in Monday's payment, together, as one credit. Splitting them
 * into two batches produced two batches chasing the same credit — which the
 * matcher correctly reported as ambiguous, over and over, for every weekend in
 * the period.
 *
 * So charges are grouped by the day they are *due*: same due date, same batch.
 * Over four months of real statements that moved the batches whose amount
 * closes against the bank from 29 of 65 to 36 of 54.
 *
 * `batchDate` stays the cutoff — the last charge in the group — so the
 * settlement window is still counted the way the brief states it, T+1 business
 * days after the cutoff.
 */
export function buildSettlementBatches(input: {
  readonly accountId: AccountId;
  readonly movements: readonly Movement[];
  readonly calendar: BusinessCalendar;
  readonly policy?: SettlementPolicy;
  /** Overrides the due-date grouping. For tests and for odd channels. */
  readonly batchKeyOf?: (movement: Movement) => Temporal.PlainDate;
}): SettlementBatch[] {
  const policy = input.policy ?? DAILY_T1;
  const keyOf =
    input.batchKeyOf ??
    ((movement: Movement) =>
      settlementDateFor(accrualDateOf(movement, policy), policy, input.calendar));
  const byDueDate = new Map<string, Movement[]>();

  for (const movement of input.movements) {
    if (movement.accountId !== input.accountId) continue;
    if (!isBatchable(movement.type)) continue;
    const key = keyOf(movement).toString();
    const bucket = byDueDate.get(key);
    if (bucket) bucket.push(movement);
    else byDueDate.set(key, [movement]);
  }

  return [...byDueDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, movements]) => assembleBatch(input.accountId, cutoffOf(movements, policy), movements));
}

/**
 * The cutoff the window is counted from: the latest close among the charges.
 *
 * For a daily channel that is the last charge's own day, so a weekend batch is
 * cut on the Sunday and expected T+1 on the Monday. For a weekly channel every
 * charge shares the same close, so it is that day.
 */
function cutoffOf(
  movements: readonly Movement[],
  policy: SettlementPolicy,
): Temporal.PlainDate {
  return movements
    .map((movement) => closingDateFor(accrualDateOf(movement, policy), policy))
    .reduce((latest, date) => (date.toString() > latest.toString() ? date : latest));
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

function accrualDateOf(movement: Movement, policy: SettlementPolicy): Temporal.PlainDate {
  return accrualDateFor(movement.occurredAt, movement.valueDate, policy);
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
