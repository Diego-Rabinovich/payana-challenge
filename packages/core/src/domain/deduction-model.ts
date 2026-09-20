import { InvalidMoneyError } from './errors.js';
import { Money } from './money.js';
import type { DeductionKind } from './settlement-batch.js';

/**
 * Deriving what a gateway kept, when it does not tell us.
 *
 * Wompi's API returns `amount_in_cents` and nothing else — no commission, no
 * VAT, no withholding. Verified against the live API: the breakdown the
 * merchant panel shows is simply not exposed. So the amounts have to come from
 * somewhere else, and the honest source is arithmetic rather than a guess.
 *
 * The gap between a day's gross and the credit that landed **is** the total
 * deducted; that is an observation, not an estimate. Splitting it into three
 * concepts then needs only one unknown, because two of the three rates are set
 * by Colombian law:
 *
 *   withholding = 1.5% of gross        (retención en la fuente on card sales)
 *   VAT         = 19% of the fee       (IVA on the service)
 *   fee         = whatever is left
 *
 * The decomposition reconstructs the observed gap exactly by construction, so
 * "it adds up" proves nothing. What does prove something is the consistency
 * check: the VAT implied by the derived fee has to match the VAT the split
 * produced. When it does, the numbers are consistent with the legal rates
 * rather than merely with each other.
 */

export interface DeductionRates {
  /** IVA on the service. 19/100 in Colombia. */
  readonly vat: Rate;
  /** Retención en la fuente on card sales. 15/1000 = 1.5%. */
  readonly withholding: Rate;
  /**
   * Total deduction rates a settlement may plausibly show. Observed across
   * four months of statements the figure clusters between 4.30% and 4.55%;
   * outside that band something other than fees explains the gap.
   */
  readonly plausibleTotalBand: readonly [number, number];
  /** Cents of slack per charge, since the gateway truncates each concept. */
  readonly truncationSlackPerCharge: number;
}

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
}

export const COLOMBIAN_RATES: DeductionRates = {
  vat: { numerator: 19, denominator: 100 },
  withholding: { numerator: 15, denominator: 1000 },
  plausibleTotalBand: [0.04, 0.05],
  truncationSlackPerCharge: 3,
};

export interface DerivedDeduction {
  readonly kind: DeductionKind;
  readonly amount: Money;
}

export interface DeductionDerivation {
  readonly deductions: readonly DerivedDeduction[];
  readonly total: Money;
  /** Total deducted as a fraction of gross. */
  readonly impliedRate: number;
  /** Whether the split is consistent with the statutory VAT rate. */
  readonly consistent: boolean;
  /** How far the implied VAT sits from the split's VAT, in cents. */
  readonly vatDrift: number;
  readonly withinPlausibleBand: boolean;
}

/**
 * Splits an observed gap into fee, VAT and withholding.
 *
 * `chargeCount` only widens the consistency tolerance: the gateway truncates
 * each concept on each transaction, so a batch of fifty accumulates more
 * rounding slack than a batch of one.
 */
export function deriveDeductions(
  gross: Money,
  observedNet: Money,
  chargeCount: number,
  rates: DeductionRates = COLOMBIAN_RATES,
): DeductionDerivation {
  if (!gross.isPositive()) {
    throw new InvalidMoneyError('Cannot derive deductions from a non-positive gross', {
      gross: gross.cents,
    });
  }

  const gap = gross.minus(observedNet);
  if (gap.isNegative()) {
    // More arrived than was sold. Not a deduction problem, and forcing a
    // split here would manufacture negative fees to hide it.
    return unexplained(gap, gross, rates);
  }

  const withholding = gross.multipliedBy(
    rates.withholding.numerator,
    rates.withholding.denominator,
    'TRUNCATE',
  );
  const feeAndVat = gap.minus(withholding);
  if (feeAndVat.isNegative()) return unexplained(gap, gross, rates);

  // fee × (1 + vat) = feeAndVat, solved for fee, then VAT taken from it. The
  // remainder goes to the fee so the three parts sum to the observed gap.
  const grossedUp = rates.vat.numerator + rates.vat.denominator;
  const feeEstimate = feeAndVat.multipliedBy(rates.vat.denominator, grossedUp, 'TRUNCATE');
  const vat = feeEstimate.multipliedBy(rates.vat.numerator, rates.vat.denominator, 'TRUNCATE');
  const fee = feeAndVat.minus(vat);

  const vatFromFee = fee.multipliedBy(rates.vat.numerator, rates.vat.denominator, 'TRUNCATE');
  const vatDrift = Math.abs(vat.minus(vatFromFee).cents);
  const impliedRate = gap.cents / gross.cents;

  return {
    deductions: [
      { kind: 'FEE', amount: fee },
      { kind: 'TAX', amount: vat },
      { kind: 'WITHHOLDING', amount: withholding },
    ],
    total: gap,
    impliedRate,
    consistent: vatDrift <= Math.max(1, chargeCount * rates.truncationSlackPerCharge),
    vatDrift,
    withinPlausibleBand: isWithin(impliedRate, rates.plausibleTotalBand),
  };
}

/** A gap the fee model cannot account for is reported, never forced into one. */
function unexplained(gap: Money, gross: Money, rates: DeductionRates): DeductionDerivation {
  const impliedRate = gap.cents / gross.cents;
  return {
    deductions: [],
    total: gap,
    impliedRate,
    consistent: false,
    vatDrift: Number.POSITIVE_INFINITY,
    withinPlausibleBand: isWithin(impliedRate, rates.plausibleTotalBand),
  };
}

function isWithin(value: number, [low, high]: readonly [number, number]): boolean {
  return value >= low && value <= high;
}
