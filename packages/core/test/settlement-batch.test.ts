import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { TEST_HOLIDAYS } from '../src/testing/ruleset-fixture.js';

const CAL = new BusinessCalendar(TEST_HOLIDAYS);
import { Money } from '../src/domain/money.js';
import type { Movement, MovementType } from '../src/domain/movement.js';
import {
  buildSettlementBatches,
  identityHolds,
  totalDeductions,
} from '../src/domain/settlement-batch.js';
import { WOMPI_ACCOUNT, aMovement } from '../src/testing/builders.js';

/**
 * Amounts are the ones observed on a real Wompi transaction of $317,549.00:
 * fee 7,862.40 · VAT 1,493.85 · withholding 4,763.23 · net 303,429.52.
 */
function aSale(date: string, cents: { gross: number; fee: number; tax: number; withholding: number }) {
  const reference = `tx-${date}-${cents.gross}`;
  const part = (type: MovementType, amount: number, tag: string): Movement =>
    aMovement({
      type,
      externalId: reference,
      amount: Money.ofCents(amount),
      valueDate: Temporal.PlainDate.from(date),
      source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: `${reference}:${tag}` },
    });

  return [
    part('CHARGE', cents.gross, 'charge'),
    part('FEE', -cents.fee, 'fee'),
    part('TAX', -cents.tax, 'tax'),
    part('WITHHOLDING', -cents.withholding, 'withholding'),
  ];
}

const SALE = { gross: 31_754_900, fee: 786_240, tax: 149_385, withholding: 476_323 };

describe('buildSettlementBatches (F02-T03)', () => {
  it('groups a day of sales into one batch and computes what the bank should receive', () => {
    const [batch] = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: aSale('2025-12-31', SALE),
    });

    expect(batch?.batchDate.toString()).toBe('2025-12-31');
    expect(batch?.gross.cents).toBe(31_754_900);
    expect(batch?.expectedNet.cents).toBe(30_342_952);
  });

  it('keeps the three deductions apart, so the ERP entry can be built from them', () => {
    const [batch] = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: aSale('2025-12-31', SALE),
    });

    expect(batch?.deductions.map((d) => [d.kind, d.amount.cents])).toEqual([
      ['FEE', 786_240],
      ['TAX', 149_385],
      ['WITHHOLDING', 476_323],
    ]);
    expect(totalDeductions(batch!.deductions).cents).toBe(1_411_948);
  });

  it('marks deductions EXPLICIT when the source reported them', () => {
    const [batch] = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: aSale('2025-12-31', SALE),
    });

    expect(batch?.deductions.every((d) => d.basis === 'EXPLICIT')).toBe(true);
  });

  it('separates days into their own batches, in date order', () => {
    const batches = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [...aSale('2026-01-02', SALE), ...aSale('2025-12-31', SALE)],
    });

    expect(batches.map((b) => b.batchDate.toString())).toEqual(['2025-12-31', '2026-01-02']);
  });

  it('adds up several sales on the same day', () => {
    const batches = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [
        ...aSale('2025-12-31', SALE),
        ...aSale('2025-12-31', { gross: 24_369_800, fee: 603_568, tax: 114_677, withholding: 365_547 }),
      ],
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.gross.cents).toBe(31_754_900 + 24_369_800);
    expect(batches[0]?.chargeIds).toHaveLength(2);
  });

  it('nets refunds out of the gross rather than treating them as deductions', () => {
    const refund = aMovement({
      type: 'REFUND',
      amount: Money.ofCents(-10_000_000),
      valueDate: Temporal.PlainDate.from('2025-12-31'),
      source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: 'refund' },
    });

    const [batch] = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [...aSale('2025-12-31', SALE), refund],
    });

    expect(batch?.gross.cents).toBe(31_754_900 - 10_000_000);
    expect(batch?.deductions).toHaveLength(3);
  });

  it('ignores movements belonging to another account', () => {
    const batches = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: [aMovement({ accountId: 'bancolombia:other' as never, type: 'CHARGE' })],
    });

    expect(batches).toEqual([]);
  });

  it('gives a day with no activity no batch at all (F02-T09)', () => {
    expect(buildSettlementBatches({ calendar: CAL, accountId: WOMPI_ACCOUNT, movements: [] })).toEqual([]);
  });

  it('derives the same batch id for the same account and day', () => {
    const once = buildSettlementBatches({ calendar: CAL, accountId: WOMPI_ACCOUNT, movements: aSale('2025-12-31', SALE) });
    const twice = buildSettlementBatches({ calendar: CAL, accountId: WOMPI_ACCOUNT, movements: aSale('2025-12-31', SALE) });

    expect(once[0]?.id).toBe(twice[0]?.id);
    expect(once[0]?.id).toMatch(/^bat_[0-9a-f]{16}$/);
  });
});

describe('identityHolds', () => {
  it('confirms that gross equals net plus every deduction', () => {
    const [batch] = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: aSale('2025-12-31', SALE),
    });

    expect(identityHolds(batch!)).toBe(true);
  });

  it('is the same identity the ERP entry has to balance on', () => {
    const [batch] = buildSettlementBatches({
      calendar: CAL,
      accountId: WOMPI_ACCOUNT,
      movements: aSale('2025-12-31', SALE),
    });

    const debits = batch!.expectedNet.plus(totalDeductions(batch!.deductions));
    expect(debits.cents).toBe(batch!.gross.cents);
  });
});
