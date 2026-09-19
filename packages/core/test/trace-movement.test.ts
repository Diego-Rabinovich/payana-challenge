import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../src/domain/business-calendar.js';
import { TEST_HOLIDAYS } from '../src/testing/ruleset-fixture.js';

const CAL = new BusinessCalendar(TEST_HOLIDAYS);
import { accountId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import type { Movement, MovementType } from '../src/domain/movement.js';
import { buildSettlementBatches } from '../src/domain/settlement-batch.js';
import { aMovement } from '../src/testing/builders.js';
import { attribute, traceMovement } from '../src/usecases/trace-movement.js';

const WOMPI = accountId('wompi:AA');
const DATE = '2025-12-31';

function part(type: MovementType, cents: number, tag: string): Movement {
  return aMovement({
    accountId: WOMPI,
    type,
    amount: Money.ofCents(cents),
    valueDate: Temporal.PlainDate.from(DATE),
    source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: tag },
  });
}

/** Three sales in one day, one set of deductions. */
function aDay() {
  const charges = [
    part('CHARGE', 31_754_900, 'charge-a'),
    part('CHARGE', 24_369_800, 'charge-b'),
    part('CHARGE', 15_460_800, 'charge-c'),
  ];
  const movements = [
    ...charges,
    part('FEE', -1_754_900, 'fee'),
    part('TAX', -333_431, 'tax'),
    part('WITHHOLDING', -1_067_772, 'withholding'),
  ];
  const [batch] = buildSettlementBatches({ calendar: CAL, accountId: WOMPI, movements });
  return { charges, batch: batch! };
}

describe('attribute (F02-T13, F02-T16)', () => {
  it('splits the settlement net across the day’s payments', () => {
    const { charges, batch } = aDay();

    const shares = charges.map((charge) => attribute(charge, batch.expectedNet, charges));

    expect(shares.every((share) => share.isPositive())).toBe(true);
  });

  it('never loses or invents a cent: the shares sum to the net exactly', () => {
    const { charges, batch } = aDay();

    const shares = charges.map((charge) => attribute(charge, batch.expectedNet, charges));

    expect(Money.sum(shares).cents).toBe(batch.expectedNet.cents);
  });

  it('gives the larger payment the larger share', () => {
    const { charges, batch } = aDay();

    const biggest = attribute(charges[0]!, batch.expectedNet, charges);
    const smallest = attribute(charges[2]!, batch.expectedNet, charges);

    expect(biggest.compareTo(smallest)).toBe(1);
  });

  it('returns zero for a payment that is not in the batch', () => {
    const { batch, charges } = aDay();
    const stranger = part('CHARGE', 1_000, 'stranger');

    expect(attribute(stranger, batch.expectedNet, charges).isZero()).toBe(true);
  });
});

describe('traceMovement', () => {
  it('walks the money from the payment to the batch and its expected net', () => {
    const { charges, batch } = aDay();

    const lineage = traceMovement({ charge: charges[0]!, batch, charges });

    expect(lineage.steps.map((step) => step.stage)).toEqual(['CHARGE', 'BATCH', 'SETTLEMENT']);
    expect(lineage.settled).toBe(false);
    expect(lineage.gross.cents).toBe(31_754_900);
  });

  it('adds the bank credit once the batch has matched one', () => {
    const { charges, batch } = aDay();
    const credit = aMovement({
      accountId: accountId('bancolombia:00000000000'),
      type: 'TRANSFER_IN',
      amount: batch.expectedNet,
      valueDate: Temporal.PlainDate.from('2026-01-02'),
      counterparty: 'WOMPI S.A.S.',
      source: { sourceId: aMovement().source.sourceId, rawRecordId: aMovement().source.rawRecordId, locator: 'credit' },
    });

    const lineage = traceMovement({
      charge: charges[0]!,
      batch,
      charges,
      match: { id: 'mat_x', amounts: { observedNet: credit.amount } } as never,
      bankCredit: credit,
    });

    expect(lineage.steps.map((step) => step.stage)).toEqual([
      'CHARGE',
      'BATCH',
      'SETTLEMENT',
      'BANK_CREDIT',
    ]);
    expect(lineage.settled).toBe(true);
    expect(lineage.bankCreditId).toBe(credit.id);
  });

  it('answers the brief’s question: where did this one payment’s money end up', () => {
    const { charges, batch } = aDay();

    const lineage = traceMovement({ charge: charges[0]!, batch, charges });

    // Gross collected, net attributed, and every id needed to check the claim.
    expect(lineage.gross.cents).toBeGreaterThan(lineage.attributedNet.cents);
    expect(lineage.batchId).toBe(batch.id);
    expect(lineage.movementId).toBe(charges[0]!.id);
  });
});
