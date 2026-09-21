import {
  EVIDENCE_CODES,
  EVIDENCE_DIMENSIONS,
  type EvidenceCode,
  type RubricDto,
  type RunReportDto,
} from '@aa/contracts';
import {
  type AccountMap,
  type ErpReconciliationReport,
  type ReconciliationReport,
  type RuleSet,
  type RunRecord,
  attainableScore,
} from '@aa/core';
import {
  toErpReconciliationDto,
  toReconciliationDto,
  toReconciliationSummaryDto,
  toUnattributedCreditDto,
} from './reconciliation.presenter.js';

/**
 * The rubric as data: every code, its weight, what it excludes, whether it
 * disqualifies.
 *
 * Built from the live ruleset rather than written down, so the glossary, the
 * API and the report a model reads cannot disagree about what a code is worth.
 */
export function toRubricDto(ruleSet: RuleSet, rulesetVersion: string): RubricDto {
  const { weights, exclusiveDimensions, bands, ambiguityDelta, disqualifying } = ruleSet.config;

  const groupOf = (code: string) =>
    Object.values(exclusiveDimensions).find((codes) =>
      (codes as readonly string[]).includes(code),
    ) ?? [];

  return {
    rulesetVersion,
    attainable: attainableScore(ruleSet.scoring),
    bands,
    ambiguityDelta,
    codes: EVIDENCE_CODES.map((code) => ({
      code,
      dimension: EVIDENCE_DIMENSIONS[code],
      ...(weights[code] !== undefined ? { weight: weights[code] } : {}),
      disqualifying: (disqualifying ?? []).includes(code),
      exclusiveWith: (groupOf(code) as readonly EvidenceCode[]).filter((other) => other !== code),
      meaning: code,
    })),
  };
}

/**
 * Everything one run concluded, in one file, in the shape the API serves.
 *
 * Esto es lo que se le da a una IA que no puede conectarse al MCP. No es el
 * objeto interno serializado — ése tiene los montos como centavos crudos y las
 * explicaciones con `COP 2941468300` adentro —, sino los mismos DTOs que
 * devuelven la API y las herramientas del MCP, validados por el mismo esquema.
 * Trae las dos fases y la rúbrica, así que se puede leer sin nada más: qué se
 * concluyó, con qué evidencia, y qué vale cada código que se cita.
 */
export function toRunReportDto(input: {
  run: RunRecord;
  flow: ReconciliationReport;
  erp: Readonly<Record<string, ErpReconciliationReport>>;
  ruleSet: RuleSet;
  accountMap: AccountMap;
}): RunReportDto {
  const { run, flow, erp, ruleSet, accountMap } = input;

  return {
    schema: 'conciliacion-alcazar/run-report@1',
    run: {
      id: run.id,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      rulesetVersion: run.rulesetVersion,
      range: run.range,
      inputHashes: { ...run.inputHashes },
    },
    summary: toReconciliationSummaryDto(flow, ruleSet.version, (counterparty) =>
      ruleSet.isChannelCounterparty('wompi', counterparty),
    ),
    reconciliations: flow.matches.map(toReconciliationDto),
    unattributedCredits: flow.unattributed.map(toUnattributedCreditDto),
    erp: Object.fromEntries(
      Object.entries(erp).map(([journal, report]) => [
        journal,
        toErpReconciliationDto(report, accountMap),
      ]),
    ),
    rubric: toRubricDto(ruleSet, ruleSet.version),
  };
}
