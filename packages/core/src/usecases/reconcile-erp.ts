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
    // Decided over the whole journal at once, not one group at a time: the
    // old cascade let whichever group came first claim an entry, which on a
    // day with several movements handed it to the wrong one. See
    // erp-assignment.ts.
    const assignment = assignErpMatches(groups, context);

    const lines: ErpReconciliationLine[] = [
      ...this.duplicateLines(groups, index),
      ...groups.map((group) => this.reconcileGroup(group, assignment, context, input)),
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
  ): ErpReconciliationLine {
    const match = assignment.get(group.key);
    if (match) {
      const assessment = assessMatch(group, match, context);

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
      ],
      ...this.correctionFor(group, input.journalKey, 'MISSING_ENTRY', []),
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
  ) {
    if (reason === 'INCOMPLETE_ENTRY' && missingConcepts.length === 0) return {};
    if (group.concepts.some((concept) => !this.accountMap.isMapped(concept))) return {};

    // Un traspaso sólo se puede proponer si sabemos de qué otro libro salió.
    // Sin contrapartida el asiento tendría una sola línea, no cuadraría, y
    // ofrecerlo sería ofrecer algo que Odoo no aceptaría.
    const transfer = group.concepts.every(
      (concept) => concept === 'TRANSFER_IN' || concept === 'TRANSFER_OUT',
    );
    const counterpart = transfer ? this.counterpartJournalOf(group, journalKey) : undefined;
    if (transfer && counterpart === undefined) return {};

    return {
      correction: buildCorrection({
        movements: group.movements,
        journalKey,
        reason,
        missingConcepts,
        ...(counterpart ? { counterpartJournalKey: counterpart } : {}),
      }),
    };
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
