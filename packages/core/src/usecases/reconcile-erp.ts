import type { AccountMap } from '../domain/account-map.js';
import type { BusinessCalendar } from '../domain/business-calendar.js';
import { ConfigurationError } from '../domain/errors.js';
import { externalReferenceOf } from '../domain/erp-entry.js';
import {
  type ErpLineStatus,
  type ErpReconciliationLine,
  type ErpReconciliationReport,
  type LedgerGroup,
  groupForComparison,
} from '../domain/erp-reconciliation.js';
import { evidence } from '../domain/evidence.js';
import type { AccountId, RunId } from '../domain/ids.js';
import type { MatchResult } from '../domain/match-result.js';
import type { Movement } from '../domain/movement.js';
import type { ErpEntry } from '../domain/erp-entry.js';
import type { ErpCorrection } from '../domain/erp-correction.js';
import { Money } from '../domain/money.js';
import { buildCorrection } from '../domain/erp-correction.js';
import type { ErpGateway } from '../ports/erp-gateway.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { MovementRepository } from '../ports/repositories.js';
import type { DateRange } from '../ports/source-connector.js';
import { ErpEntryIndex } from '../rules/erp-entry-index.js';
import { type ErpAssignment, assignErpMatches } from '../rules/erp-assignment.js';
import { assessMatch } from '../rules/erp-assessment.js';
import {
  type ErpMatchContext,
  type ErpMatchStrategy,
  defaultErpStrategies,
  ledgerAmountOf,
} from '../rules/erp-match-strategy.js';

export interface ReconcileErpInput {
  readonly accountId: AccountId;
  /** Journal key in the account map, e.g. 'wompi' or 'bancolombia'. */
  readonly journalKey: string;
  readonly range: DateRange;
  readonly runId?: RunId;
  /**
   * Los resultados de la fase 2, para el diario del canal. Se leen, no se
   * tocan: de ahí salen la comisión, el IVA y la retención de cada liquidación.
   */
  readonly settlements?: readonly MatchResult[];
}

/** La parte de las deducciones de una liquidación que le toca a una venta. */
interface DeductionShare {
  readonly fee: Money;
  readonly tax: Money;
  readonly withholding: Money;
}

export interface ReconcileErpOptions {
  readonly dateShiftBusinessDays?: number;
  /**
   * Para saber de quién es una contraparte.
   *
   * Sin esto un traspaso no se puede proponer como asiento: sabríamos que
   * entró plata al banco y no contra qué cuenta va la otra mitad.
   */
  readonly ruleSet?: RuleSet;
}

/**
 * Phase 3: does the system of record reflect what actually happened?
 *
 * Every element of both sides ends up in the report with a status and the
 * criterion that produced it. Nothing is dropped in the middle: an entry we
 * cannot explain and a movement the ERP never recorded are both findings, and
 * a silent omission would be indistinguishable from agreement.
 */
export class ReconcileErp {
  private readonly strategies: readonly ErpMatchStrategy[];

  constructor(
    private readonly erp: ErpGateway,
    private readonly movements: MovementRepository,
    private readonly accountMap: AccountMap,
    private readonly calendar: BusinessCalendar,
    strategies?: readonly ErpMatchStrategy[],
    private readonly options: ReconcileErpOptions = {},
  ) {
    this.strategies = strategies ?? defaultErpStrategies();
  }

  async execute(input: ReconcileErpInput): Promise<ErpReconciliationReport> {
    const journal = this.accountMap.journal(input.journalKey);
    if (!journal) {
      throw new ConfigurationError(`Unknown journal key ${input.journalKey}`, {
        journalKey: input.journalKey,
      });
    }

    const ledgerMovements = await this.movements.findByAccount(input.accountId, input.range);
    const entries = await this.erp.readJournal(journal.id, input.range);

    const index = new ErpEntryIndex(entries, journal.mainAccount);
    const context: ErpMatchContext = {
      index,
      accountMap: this.accountMap,
      journal,
      calendar: this.calendar,
      dateShiftBusinessDays: this.options.dateShiftBusinessDays ?? 2,
    };

    const groups = groupForComparison(ledgerMovements);
    const shares = this.deductionShares(input.settlements, ledgerMovements);
    // Decided over the whole journal at once, not one group at a time: the
    // old cascade let whichever group came first claim an entry, which on a
    // day with several movements handed it to the wrong one. See
    // erp-assignment.ts.
    const assignment = assignErpMatches(groups, context);

    const lines: ErpReconciliationLine[] = [
      ...this.duplicateLines(groups, index),
      ...groups.map((group) => this.reconcileGroup(group, assignment, context, input, shares)),
      ...this.orphanEntries(index),
    ];

    return {
      ...(input.runId ? { runId: input.runId } : {}),
      journalId: journal.id,
      journalName: journal.name,
      lines,
      totals: summarise(lines, groups.length, index.size),
    };
  }

  /**
   * Two entries carrying the same transaction reference. Flagged before
   * matching, because whichever one we happened to claim first would
   * otherwise look correct and the other would look orphaned.
   */
  private duplicateLines(
    groups: readonly LedgerGroup[],
    index: ErpEntryIndex,
  ): ErpReconciliationLine[] {
    return groups.flatMap((group) => {
      const withSameRef = index.allWithReference(group.key);
      if (withSameRef.length < 2) return [];

      return [
        {
          status: 'DUPLICATE_IN_ERP' as ErpLineStatus,
          matchLevel: 'REF' as const,
          ledgerMovementIds: group.movements.map((movement) => movement.id),
          ...describe(group),
          date: group.date,
          ledgerAmount: ledgerAmountOf(group),
          evidence: [
            evidence('DUPLICATE_IN_ERP', 'ERP', false, {
              expected: '1',
              observed: String(withSameRef.length),
              detail: withSameRef.map((entry) => entry.name).join(', '),
            }),
          ],
        },
      ];
    });
  }

  private reconcileGroup(
    group: LedgerGroup,
    assignment: ErpAssignment,
    context: ErpMatchContext,
    input: ReconcileErpInput,
    shares: ReadonlyMap<string, DeductionShare>,
  ): ErpReconciliationLine {
    const share = shareOf(group, shares);
    const match = assignment.get(group.key);
    if (match) {
      const assessment = assessMatch(group, match, context);

      // El asiento registra la venta al bruto y nada más. La venta coincide,
      // pero Wompi se quedó una comisión, su IVA y una retención que ese asiento
      // no dice: le faltan líneas. Se muestran, sin ofrecer escribirlas.
      if (assessment.status === 'MATCHED' && share && !this.touchesDeductions(match.entry)) {
        return {
          status: 'INCOMPLETE_ENTRY',
          matchLevel: match.level,
          ledgerMovementIds: group.movements.map((movement) => movement.id),
          erpEntryId: match.entry.id,
          erpEntryName: match.entry.name,
          erpEntryState: match.entry.state,
          ...describe(group),
          date: group.date,
          ledgerAmount: assessment.ledgerAmount,
          ...(assessment.erpAmount ? { erpAmount: assessment.erpAmount } : {}),
          evidence: [
            ...assessment.evidence,
            evidence('INCOMPLETE_ENTRY', 'ERP', false, {
              detail: 'faltan: FEE, TAX, WITHHOLDING',
            }),
            derivedEvidence(share),
          ],
          correction: missingLines(group, share, input.journalKey),
        };
      }

      return {
        status: assessment.status,
        matchLevel: match.level,
        ledgerMovementIds: group.movements.map((movement) => movement.id),
        erpEntryId: match.entry.id,
        erpEntryName: match.entry.name,
        erpEntryState: match.entry.state,
        ...describe(group),
        date: group.date,
        ledgerAmount: assessment.ledgerAmount,
        ...(assessment.erpAmount ? { erpAmount: assessment.erpAmount } : {}),
        ...(assessment.delta ? { delta: assessment.delta } : {}),
        evidence: assessment.evidence,
        ...this.correctionFor(group, input.journalKey, 'INCOMPLETE_ENTRY', assessment.missingConcepts),
      };
    }

    return {
      status: 'MISSING_IN_ERP',
      matchLevel: 'NONE',
      ledgerMovementIds: group.movements.map((movement) => movement.id),
      ...describe(group),
      date: group.date,
      ledgerAmount: ledgerAmountOf(group),
      evidence: [
        evidence('MISSING_IN_ERP', 'ERP', false, {
          expected: group.key,
          observed: 'sin asiento',
          detail: `diario ${context.journal.name}`,
        }),
        ...this.unmappedEvidence(group, context),
        ...this.contraEvidence(group, input.journalKey),
        ...(share ? [derivedEvidence(share)] : []),
      ],
      ...this.correctionFor(group, input.journalKey, 'MISSING_ENTRY', [], share),
    };
  }

  /**
   * What would fix the discrepancy, as data: the movements the ERP should have
   * recorded, signed the way the ledger holds them. Turning that into whatever
   * shape the ERP wants is the gateway's job, not this one's.
   *
   * Skipped when the chart does not cover one of the concepts — a correction
   * against an invented account would be worse than reporting there is no
   * account.
   */
  private correctionFor(
    group: LedgerGroup,
    journalKey: string,
    reason: 'MISSING_ENTRY' | 'INCOMPLETE_ENTRY',
    missingConcepts: readonly (typeof group.concepts)[number][],
    share?: DeductionShare,
  ) {
    if (reason === 'INCOMPLETE_ENTRY' && missingConcepts.length === 0) return {};
    if (!this.isChannelMoney(group, journalKey)) return {};
    if (group.concepts.some((concept) => !this.accountMap.isMapped(concept))) return {};

    // Un traspaso sólo se puede proponer si sabemos de qué otro libro salió.
    // Sin contrapartida el asiento tendría una sola línea, no cuadraría, y
    // ofrecerlo sería ofrecer algo que Odoo no aceptaría.
    const transfer = group.concepts.every(
      (concept) => concept === 'TRANSFER_IN' || concept === 'TRANSFER_OUT',
    );
    const counterpart = transfer ? this.counterpartJournalOf(group, journalKey) : undefined;
    if (transfer && counterpart === undefined) return {};

    const correction = buildCorrection({
      movements: group.movements,
      journalKey,
      reason,
      missingConcepts,
      ...(counterpart ? { counterpartJournalKey: counterpart } : {}),
    });

    // Una venta que falta se propone completa: además del bruto, lo que Wompi
    // retuvo. El adapter la arma como D neto + D comisión + D IVA + D retención
    // contra C ventas al bruto, que es como tendría que haber quedado.
    return { correction: share ? withDeductions(correction, share) : correction };
  }

  /**
   * La parte que le toca a cada venta de lo que el canal retuvo en su liquidación.
   *
   * Wompi no informa la comisión por transacción: la fase 2 la deriva por
   * liquidación. Se reparte entre los pagos del lote en proporción al bruto,
   * con el mismo reparto de restos que usa *Correlacionar* para el neto
   * atribuido, así que las partes suman exacto lo derivado. Sólo liquidaciones
   * cuyo desglose cerró contra el IVA de ley: repartir un split que el propio
   * modelo no cree sería inventar la comisión de cada venta.
   */
  private deductionShares(
    settlements: readonly MatchResult[] | undefined,
    movements: readonly Movement[],
  ): Map<string, DeductionShare> {
    const shares = new Map<string, DeductionShare>();
    if (!settlements) return shares;

    const byId = new Map(movements.map((movement) => [movement.id as string, movement]));
    for (const match of settlements) {
      const derived = match.derivedDeductions;
      if (!derived?.consistent) continue;

      const charges = match.left.chargeIds
        .map((id) => byId.get(id))
        .filter((movement): movement is Movement => movement !== undefined);
      if (charges.length !== match.left.chargeIds.length) continue;

      const weights = charges.map((movement) =>
        movement.type === 'CHARGE' && movement.amount.isPositive() ? movement.amount.cents : 0,
      );
      if (weights.every((weight) => weight === 0)) continue;

      const fees = derived.fee.allocate(weights);
      const taxes = derived.tax.allocate(weights);
      const withholdings = derived.withholding.allocate(weights);
      charges.forEach((movement, index) => {
        if (weights[index] === 0) return;
        shares.set(movement.id, {
          fee: fees[index]!,
          tax: taxes[index]!,
          withholding: withholdings[index]!,
        });
      });
    }
    return shares;
  }

  /** Si el asiento ya tiene alguna línea de comisión, IVA o retención. */
  private touchesDeductions(entry: ErpEntry): boolean {
    const codes = (['FEE', 'TAX', 'WITHHOLDING'] as const)
      .map((type) => this.accountMap.accountFor(type)?.code)
      .filter((code): code is string => code !== undefined);
    return entry.lines.some((line) => codes.includes(line.accountCode));
  }

  /**
   * Si esta plata pasó por un canal que conciliamos.
   *
   * El alcance del challenge es Wompi → Bancolombia → Odoo. Una comisión del
   * banco, un pago de nómina o un débito PSE entran al extracto igual que un
   * giro de Wompi, pero proponer asientos para ellos es contabilizar por el
   * cliente cosas que nadie nos pidió mirar — y hacerlo en un Odoo de
   * producción.
   *
   * Dos maneras de ser del canal: estar en su propio diario, o que la
   * contraparte del documento sea el canal. Las dos salen del ruleset, así que
   * sumar una fuente no toca esta función.
   *
   * Sin ruleset no hay a quién preguntarle el alcance y se propone como antes;
   * la composición de producción siempre lo pasa.
   */
  private isChannelMoney(group: LedgerGroup, journalKey: string): boolean {
    const ruleSet = this.options.ruleSet;
    if (!ruleSet) return true;
    if (ruleSet.channelKeys.includes(journalKey)) return true;

    const counterparty = group.movements.find((movement) => movement.counterparty)?.counterparty;
    return ruleSet.channelFor(counterparty) !== undefined;
  }

  /**
   * El otro diario nuestro que participa de un traspaso.
   *
   * Sale de la contraparte que dice el documento, no de suponer que los dos
   * únicos libros del plan son las dos puntas: un crédito de un tercero entra
   * al banco igual que uno de Wompi, y sólo uno de los dos tiene otra mitad
   * que nosotros llevemos.
   */
  private counterpartJournalOf(group: LedgerGroup, journalKey: string): string | undefined {
    const counterparty = group.movements.find((movement) => movement.counterparty)?.counterparty;
    const channel = this.options.ruleSet?.channelFor(counterparty);
    if (channel === undefined || channel === journalKey) return undefined;
    return this.accountMap.journal(channel) ? channel : undefined;
  }

  /** Por qué un traspaso no trae asiento propuesto: no sabemos la contrapartida. */
  private contraEvidence(group: LedgerGroup, journalKey: string) {
    const transfer = group.concepts.every(
      (concept) => concept === 'TRANSFER_IN' || concept === 'TRANSFER_OUT',
    );
    if (!transfer || this.counterpartJournalOf(group, journalKey) !== undefined) return [];

    const counterparty = group.movements.find((movement) => movement.counterparty)?.counterparty;
    return [
      evidence('NO_CONTRA_ACCOUNT', 'ERP', false, {
        observed: counterparty ?? 'origen desconocido',
        detail: 'no es una fuente conectada',
      }),
    ];
  }

  private unmappedEvidence(group: LedgerGroup, { accountMap }: ErpMatchContext) {
    const unmapped = group.concepts.filter((concept) => !accountMap.isMapped(concept));
    if (unmapped.length === 0) return [];

    return [
      evidence('NO_ACCOUNT_MAPPING', 'ERP', false, {
        observed: unmapped.join(', '),
        detail: 'sin cuenta en el plan del challenge',
      }),
    ];
  }

  /** Entries with nothing behind them: the ERP says money moved and we did not see it. */
  private orphanEntries(index: ErpEntryIndex): ErpReconciliationLine[] {
    return index.unclaimed().map((entry) => ({
      status: 'MISSING_IN_LEDGER' as ErpLineStatus,
      matchLevel: 'NONE' as const,
      ledgerMovementIds: [],
      erpEntryId: entry.id,
      erpEntryName: entry.name,
      erpEntryState: entry.state,
      date: entry.date,
      ...(index.amountOf(entry) !== undefined
        ? { erpAmount: Money.ofCents(index.amountOf(entry)!) }
        : {}),
      evidence: [
        evidence('MISSING_IN_LEDGER', 'ERP', false, {
          observed: entry.name,
          detail: externalReferenceOf(entry) ?? 'sin referencia',
        }),
      ],
    }));
  }
}

/** Lo que el documento dice de este grupo, para que la fila se pueda leer. */
function describe(group: LedgerGroup): { descriptor?: string; counterparty?: string } {
  const first = group.movements[0];
  if (!first) return {};

  return {
    descriptor: first.description,
    ...(first.counterparty ? { counterparty: first.counterparty } : {}),
  };
}

function summarise(
  lines: readonly ErpReconciliationLine[],
  ledgerGroups: number,
  erpEntries: number,
): ErpReconciliationReport['totals'] {
  const byStatus: Partial<Record<ErpLineStatus, number>> = {};
  for (const line of lines) {
    byStatus[line.status] = (byStatus[line.status] ?? 0) + 1;
  }

  const ledgerTotal = Money.sum(lines.map((line) => line.ledgerAmount ?? Money.zero()));
  const erpTotal = Money.sum(lines.map((line) => line.erpAmount ?? Money.zero()));

  return {
    ledgerGroups,
    erpEntries,
    byStatus,
    ledgerTotal,
    erpTotal,
    unexplained: erpTotal.minus(ledgerTotal),
  };
}

/** La parte de las deducciones que le toca al pago de este grupo, si la hay. */
function shareOf(
  group: LedgerGroup,
  shares: ReadonlyMap<string, DeductionShare>,
): DeductionShare | undefined {
  const charge = group.movements.find((movement) => movement.type === 'CHARGE');
  return charge ? shares.get(charge.id) : undefined;
}

/** Que las deducciones de esta línea son derivadas, y cómo se repartieron. */
function derivedEvidence(share: DeductionShare) {
  return evidence('DEDUCTIONS_DERIVED', 'AMOUNT', true, {
    observed: 'prorrateado por bruto dentro de su liquidación',
    detail:
      `comisión ${share.fee.toString()} · IVA ${share.tax.toString()} · ` +
      `retención ${share.withholding.toString()}`,
  });
}

/**
 * Las líneas que le faltan a un asiento de venta que ya existe.
 *
 * Tres débitos —comisión, IVA descontable, retención— contra la cuenta de
 * Wompi, que así queda con el neto que efectivamente va a llegar al banco.
 * Sólo para mostrar: agregarle líneas a un asiento contabilizado es decisión
 * de un contador. Referencia `ded:`, no `mov:`, así que no hay forma de
 * escribirlo desde este sistema.
 */
function missingLines(group: LedgerGroup, share: DeductionShare, journalKey: string): ErpCorrection {
  const charge = group.movements.find((movement) => movement.type === 'CHARGE') ?? group.movements[0]!;
  const total = share.fee.plus(share.tax).plus(share.withholding);
  return {
    ref: `ded:${charge.id}`,
    journalKey,
    date: group.date,
    reason: 'INCOMPLETE_ENTRY',
    missingConcepts: ['FEE', 'TAX', 'WITHHOLDING'],
    lines: [
      { concept: 'FEE', amount: share.fee.negate(), label: 'Comisión, prorrateada' },
      { concept: 'TAX', amount: share.tax.negate(), label: 'IVA de la comisión, prorrateado' },
      { concept: 'WITHHOLDING', amount: share.withholding.negate(), label: 'Retención, prorrateada' },
    ],
    netToAccount: total.negate(),
    mainLabel: 'Retenido por Wompi',
    readOnly: true,
  };
}

/** La corrección de una venta que falta, completada con lo que Wompi retuvo. */
function withDeductions(correction: ErpCorrection, share: DeductionShare): ErpCorrection {
  const total = share.fee.plus(share.tax).plus(share.withholding);
  return {
    ...correction,
    lines: [
      ...correction.lines,
      { concept: 'FEE', amount: share.fee.negate(), label: 'Comisión, prorrateada' },
      { concept: 'TAX', amount: share.tax.negate(), label: 'IVA de la comisión, prorrateado' },
      { concept: 'WITHHOLDING', amount: share.withholding.negate(), label: 'Retención, prorrateada' },
    ],
    netToAccount: correction.netToAccount.minus(total),
  };
}
