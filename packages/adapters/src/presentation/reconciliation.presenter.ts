import type {
  ErpReconciliationDto,
  ErpReconciliationLineDto,
  EvidenceDto,
  ProposedEntryDto,
  ReconciliationDto,
  ReconciliationSummaryDto,
  UnattributedCreditDto,
} from '@aa/contracts';
import { Money } from '@aa/core';
import type {
  AccountMap,
  ErpCorrection,
  ErpReconciliationLine,
  ErpReconciliationReport,
  Evidence,
  MatchResult,
  ReconciliationReport,
  UnattributedCredit,
} from '@aa/core';
import { isMappable, toJournalEntry } from '../odoo/journal-entry-builder.js';
import { formatMoney, humaniseAmounts } from './money-format.js';
import { toMoneyDto, toOptionalMoneyDto } from './money.presenter.js';

export function toEvidenceDto(evidence: Evidence): EvidenceDto {
  return {
    code: evidence.code,
    dimension: evidence.dimension,
    passed: evidence.passed,
    ...(evidence.applicable !== undefined ? { applicable: evidence.applicable } : {}),
    ...(evidence.weight !== undefined ? { weight: evidence.weight } : {}),
    ...(evidence.expected !== undefined ? { expected: humaniseAmounts(evidence.expected) } : {}),
    ...(evidence.observed !== undefined ? { observed: humaniseAmounts(evidence.observed) } : {}),
    ...(evidence.detail !== undefined ? { detail: humaniseAmounts(evidence.detail) } : {}),
    ...(evidence.locator !== undefined ? { locator: evidence.locator } : {}),
  };
}


export function toReconciliationDto(match: MatchResult): ReconciliationDto {
  return {
    id: match.id,
    ...(match.runId ? { runId: match.runId } : {}),
    rulesetVersion: match.rulesetVersion,
    kind: match.kind,
    status: match.status,
    left: {
      batchId: match.left.batchId,
      batchDate: match.left.batchDate.toString(),
      chargeIds: [...match.left.chargeIds],
    },
    right: match.right ? { movementIds: [...match.right.movementIds] } : null,
    rule: { id: match.rule.id, version: match.rule.version },
    amounts: {
      gross: toMoneyDto(match.amounts.gross),
      deductions: toMoneyDto(match.amounts.deductions),
      expectedNet: toMoneyDto(match.amounts.expectedNet),
      ...(match.amounts.observedNet ? { observedNet: toMoneyDto(match.amounts.observedNet) } : {}),
      ...(match.amounts.delta ? { delta: toMoneyDto(match.amounts.delta) } : {}),
      ...(match.amounts.impliedDeductionRate !== undefined
        ? { impliedDeductionRate: match.amounts.impliedDeductionRate }
        : {}),
    },
    ...(match.derivedDeductions
      ? {
          derivedDeductions: {
            fee: toMoneyDto(match.derivedDeductions.fee),
            tax: toMoneyDto(match.derivedDeductions.tax),
            withholding: toMoneyDto(match.derivedDeductions.withholding),
            total: toMoneyDto(match.derivedDeductions.total),
            impliedRate: match.derivedDeductions.impliedRate,
            consistent: match.derivedDeductions.consistent,
          },
        }
      : {}),
    window: {
      from: match.window.from.toString(),
      to: match.window.to.toString(),
      basis: match.window.basis,
    },
    confidence: {
      score: match.confidence.score,
      ...(match.confidence.disqualifiedBy
        ? { disqualifiedBy: match.confidence.disqualifiedBy }
        : {}),
      band: match.confidence.band,
      earned: match.confidence.earned,
      attainable: match.confidence.attainable,
      components: match.confidence.components.map(toEvidenceDto),
    },
    alternatives: match.alternatives.map((alternative) => ({
      movementIds: [...alternative.movementIds],
      score: alternative.score,
      rejectedBecause: alternative.rejectedBecause,
    })),
  };
}

export function toUnattributedCreditDto(credit: UnattributedCredit): UnattributedCreditDto {
  return {
    movementId: credit.movementId,
    valueDate: credit.valueDate.toString(),
    amount: toMoneyDto(credit.amount),
    ...(credit.counterparty ? { counterparty: credit.counterparty } : {}),
    description: credit.description,
    reason: credit.reason,
  };
}

/**
 * The correction as the accountant will read it: the Odoo entry it becomes.
 *
 * The translation belongs to the adapter layer, so this is the same function
 * the gateway would use to write it. What the screen shows and what would be
 * posted cannot drift apart.
 */
export function toProposedEntryDto(
  correction: ErpCorrection,
  accountMap: AccountMap,
): ProposedEntryDto | undefined {
  if (!isMappable(correction, accountMap)) return undefined;

  const entry = toJournalEntry(correction, accountMap);
  return {
    ref: entry.ref,
    journalId: entry.journalId,
    date: entry.date,
    reason: correction.reason,
    missingConcepts: [...correction.missingConcepts],
    writable: !correction.readOnly,
    lines: entry.lines.map((line) => ({
      accountCode: line.accountCode,
      accountName: line.accountName,
      debit: toMoneyDto(line.debit),
      credit: toMoneyDto(line.credit),
      label: line.label,
    })),
  };
}

/**
 * The funnel and the counts, in one object.
 *
 * Built here rather than in the browser: the UI summing a page of results
 * would make the headline depend on how many rows happened to be loaded,
 * which is exactly the kind of number that is wrong in a demo and worse in
 * production.
 */
export function toReconciliationSummaryDto(
  report: ReconciliationReport,
  rulesetVersion: string,
  channelPatterns: (counterparty: string | undefined) => boolean,
): ReconciliationSummaryDto {
  const fromChannel = report.unattributed.filter((credit) => channelPatterns(credit.counterparty));

  // A report persisted before these totals existed has neither. Falling back
  // rather than throwing matters because reports are kept, not migrated: an
  // old run should still be readable, just less detailed.
  const deductions = report.totals.deductions ?? Money.zero();
  const gross = report.totals.gross ?? report.totals.expectedNet.plus(deductions);

  return {
    ...(report.runId ? { runId: report.runId } : {}),
    rulesetVersion,
    batches: report.totals.batches,
    byStatus: { ...report.totals.byStatus },
    gross: toMoneyDto(gross),
    deductions: toMoneyDto(deductions),
    deductionsAreDerived: report.totals.deductionsAreDerived ?? false,
    expectedNet: toMoneyDto(report.totals.expectedNet),
    observedNet: toMoneyDto(report.totals.observedNet),
    unexplained: toMoneyDto(report.totals.unexplained),
    unattributed: {
      channel: fromChannel.length,
      channelAmount: toMoneyDto(
        fromChannel.reduce((total, credit) => total.plus(credit.amount), Money.zero()),
      ),
      other: report.unattributed.length - fromChannel.length,
    },
  };
}

export function toErpLineDto(
  line: ErpReconciliationLine,
  accountMap: AccountMap,
): ErpReconciliationLineDto {
  const proposed = line.correction ? toProposedEntryDto(line.correction, accountMap) : undefined;

  return {
    status: line.status,
    matchLevel: line.matchLevel,
    ledgerMovementIds: [...line.ledgerMovementIds],
    ...(line.erpEntryId ? { erpEntryId: line.erpEntryId } : {}),
    ...(line.erpEntryName ? { erpEntryName: line.erpEntryName } : {}),
    ...(line.erpEntryState ? { erpEntryState: line.erpEntryState } : {}),
    ...(line.descriptor ? { descriptor: line.descriptor } : {}),
    ...(line.counterparty ? { counterparty: line.counterparty } : {}),
    date: line.date.toString(),
    ...(line.ledgerAmount ? { ledgerAmount: toMoneyDto(line.ledgerAmount) } : {}),
    ...(line.erpAmount ? { erpAmount: toMoneyDto(line.erpAmount) } : {}),
    ...(toOptionalMoneyDto(line.delta) ? { delta: toMoneyDto(line.delta!) } : {}),
    evidence: line.evidence.map(toEvidenceDto),
    ...(proposed ? { proposedEntry: proposed } : {}),
  };
}

export function toErpReconciliationDto(
  report: ErpReconciliationReport,
  accountMap: AccountMap,
): ErpReconciliationDto {
  return {
    ...(report.runId ? { runId: report.runId } : {}),
    journalId: report.journalId,
    journalName: report.journalName,
    lines: report.lines.map((line) => toErpLineDto(line, accountMap)),
    totals: {
      ledgerGroups: report.totals.ledgerGroups,
      erpEntries: report.totals.erpEntries,
      byStatus: { ...report.totals.byStatus },
      ledgerTotal: toMoneyDto(report.totals.ledgerTotal),
      erpTotal: toMoneyDto(report.totals.erpTotal),
      unexplained: toMoneyDto(report.totals.unexplained),
    },
  };
}
