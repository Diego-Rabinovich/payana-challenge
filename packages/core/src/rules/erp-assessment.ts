import { accountCodesOf } from '../domain/erp-entry.js';
import type { ErpLineStatus } from '../domain/erp-reconciliation.js';
import type { LedgerGroup } from '../domain/erp-reconciliation.js';
import { type Evidence, evidence } from '../domain/evidence.js';
import { Money } from '../domain/money.js';
import type { MovementType } from '../domain/movement.js';
import { type ErpMatch, type ErpMatchContext, ledgerAmountOf } from './erp-match-strategy.js';

export interface ErpAssessment {
  readonly status: ErpLineStatus;
  readonly evidence: readonly Evidence[];
  readonly ledgerAmount: Money;
  readonly erpAmount?: Money;
  readonly delta?: Money;
  /** Concepts the ledger has and the entry does not record. */
  readonly missingConcepts: readonly MovementType[];
}

/**
 * Judges a pair the cascade brought together.
 *
 * Finding an entry and agreeing with it are different questions, and keeping
 * them apart means a new lookup rule inherits these checks instead of
 * reimplementing them.
 *
 * Precedence is deliberate: an entry missing its fee, VAT and withholding
 * lines will *also* show the wrong amount on the bank account, because the
 * one causes the other. Reporting the missing lines names the cause;
 * reporting the amount alone would send someone to fix a symptom.
 */
export function assessMatch(
  group: LedgerGroup,
  match: ErpMatch,
  context: ErpMatchContext,
  /**
   * Conceptos que el ledger implica sin tener un movimiento propio.
   *
   * Wompi informa sólo el bruto, así que un pago llega como un único `CHARGE`;
   * la comisión, su IVA y la retención existen, pero derivadas de la
   * liquidación. Se juzgan acá con el mismo chequeo que cualquier otro
   * concepto, en vez de en un segundo lugar que decidiera «incompleto» por su
   * cuenta.
   */
  implied: readonly MovementType[] = [],
): ErpAssessment {
  const { entry } = match;
  const ledgerAmount = ledgerAmountOf(group);
  const erpCents = context.index.amountOf(entry);
  const erpAmount = erpCents === undefined ? undefined : Money.ofCents(erpCents);

  // Un grupo agregado es *parte* del asiento, no su equivalente: la
  // asignación ya verificó que los grupos suman el asiento exacto, así que
  // restarle a este grupo el total daría una diferencia que no existe. Era
  // lo que hacía aparecer "monto distinto · delta $538.305,76" sobre una
  // agregación perfectamente correcta.
  const delta =
    match.level === 'AGGREGATED' || !erpAmount ? undefined : erpAmount.minus(ledgerAmount);

  const checks: Evidence[] = [match.evidence];
  const expected = [...new Set([...group.concepts, ...implied])];
  const missingConcepts = findMissingConcepts(expected, entry, context);

  if (missingConcepts.length > 0) {
    checks.push(
      evidence('INCOMPLETE_ENTRY', 'ERP', false, {
        expected: expectedConceptList(expected, context),
        observed: accountCodesOf(entry).join(', '),
        detail: `faltan: ${missingConcepts.join(', ')}`,
      }),
    );
    if (delta && !delta.isZero()) {
      checks.push(amountEvidence(ledgerAmount, erpAmount, delta));
    }
    return { status: 'INCOMPLETE_ENTRY', evidence: checks, ledgerAmount, ...optional(erpAmount, delta), missingConcepts };
  }

  if (delta && !delta.isZero()) {
    checks.push(amountEvidence(ledgerAmount, erpAmount, delta));
    return { status: 'AMOUNT_MISMATCH', evidence: checks, ledgerAmount, ...optional(erpAmount, delta), missingConcepts };
  }

  if (match.level === 'APPROXIMATE') {
    return { status: 'DATE_SHIFT', evidence: checks, ledgerAmount, ...optional(erpAmount, delta), missingConcepts };
  }

  return { status: 'MATCHED', evidence: checks, ledgerAmount, ...optional(erpAmount, delta), missingConcepts };
}

/**
 * Concepts the ledger recorded that the entry has no account line for.
 *
 * Only mapped concepts count: a type the given chart does not cover cannot be
 * called missing from an entry, and is reported separately as unmapped.
 */
function findMissingConcepts(
  expected: readonly MovementType[],
  entry: ErpMatch['entry'],
  { accountMap }: ErpMatchContext,
): MovementType[] {
  const present = new Set(accountCodesOf(entry));

  return expected.filter((concept) => {
    const account = accountMap.accountFor(concept);
    return account !== undefined && !present.has(account.code);
  });
}

function expectedConceptList(
  expected: readonly MovementType[],
  { accountMap }: ErpMatchContext,
): string {
  return expected
    .map((concept) => accountMap.accountFor(concept)?.code)
    .filter((code): code is string => code !== undefined)
    .join(', ');
}

function amountEvidence(ledger: Money, erp: Money | undefined, delta: Money): Evidence {
  return evidence('AMOUNT_MISMATCH_ERP', 'ERP', false, {
    expected: ledger.toString(),
    observed: (erp ?? Money.zero()).toString(),
    detail: `delta ${delta.toString()}`,
  });
}

function optional(erpAmount: Money | undefined, delta: Money | undefined) {
  return {
    ...(erpAmount ? { erpAmount } : {}),
    ...(delta ? { delta } : {}),
  };
}
