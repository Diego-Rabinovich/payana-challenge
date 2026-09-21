import {
  EVIDENCE_CODES,
  EVIDENCE_DIMENSIONS,
  ErpReconciliationDto,
  EvidenceCodeDto,
  MoneyDto,
  MovementDto,
  ReconciliationDto,
  UnattributedCreditDto,
} from '@aa/contracts';
import {
  toErpReconciliationDto,
  toLineageDto,
  toMoneyDto,
  toMovementDto,
  toReconciliationDto,
  toUnattributedCreditDto,
} from '@aa/adapters';
import { LATEST_RUN, type ReadModel } from '@aa/core';
import { z } from 'zod';

/**
 * What an AI accountant can ask this system.
 *
 * Three rules hold for every tool here, and they are the point of the design
 * rather than a caveat on it:
 *
 *   1. No tool computes anything. Each one reads a result the deterministic
 *      core already produced. A model is never in the path where an amount is
 *      decided.
 *   2. Tools return the same DTOs as the HTTP API. There is no second schema
 *      to keep in step, because there is no second schema.
 *   3. There are no write tools. Creating entries in a production ERP does not
 *      belong one prompt away; that stays in the console, behind a button a
 *      person pressed, with its own undo.
 *
 * The reason this exists at all is context. Handing a year of ledgers to a
 * model means pasting hundreds of thousands of movements into a prompt; they
 * do not fit, and if they did the model would drown. This turns it into a
 * conversation where the agent asks for what it needs.
 */

export interface Tool<Input extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly output: z.ZodTypeAny;
  run(input: z.infer<Input>, model: ReadModel): Promise<unknown>;
}

/**
 * De qué corrida habla la pregunta.
 *
 * `latest` es el default y es explícito: el valor viaja hasta el read model,
 * que lo convierte en un id concreto. Antes era la ausencia del campo lo que
 * significaba «la última», y un agente que listaba excepciones de una corrida
 * y después pedía el detalle de una podía recibir la versión de otra sin que
 * nada en la respuesta lo dijera.
 */
const RunScope = z.object({
  runId: z.string().default('latest').describe('Id de la corrida, o `latest`'),
});

/**
 * Un id concreto, o undefined si esa corrida no existe.
 *
 * Acepta ausente además de `latest` porque el default vive en el esquema Zod
 * y un llamador directo —un test, otro proceso— no pasa por ahí. Que la
 * función sea total evita que ese caso se vea como «no existe la corrida».
 */
async function resolved(runId: string | undefined, model: ReadModel): Promise<string | undefined> {
  return model.runs.resolve(runId ?? LATEST_RUN);
}

/** The funnel, which is the one number a CFO asks for first. */
const getRunSummary: Tool = {
  name: 'get_run_summary',
  description:
    'The money funnel for a run: gross collected, deductions, what we expected the bank to receive, what it actually received, and the difference. Start here.',
  input: RunScope,
  output: z.object({
    runId: z.string().optional(),
    rulesetVersion: z.string(),
    batches: z.number().int(),
    byStatus: z.record(z.number().int()),
    expectedNet: MoneyDto,
    observedNet: MoneyDto,
    unexplained: MoneyDto,
    unattributedCredits: z.number().int(),
  }),
  async run(input: z.infer<typeof RunScope>, model) {
    const runId = await resolved(input.runId, model);
    if (!runId) return { error: `no run ${input.runId}` };

    const report = await model.flow.flowReport(runId);
    if (!report) return { error: `run ${runId} has no phase-2 report` };

    return {
      ...(report.runId ? { runId: report.runId } : {}),
      rulesetVersion: report.rulesetVersion,
      batches: report.totals.batches,
      byStatus: report.totals.byStatus,
      // Through toMoneyDto like every other amount in the system. Calling
      // toString here worked until a report came back from Postgres, where
      // Money is JSON rather than a value object and the agent was handed
      // "[object Object]" as a figure.
      expectedNet: toMoneyDto(report.totals.expectedNet),
      observedNet: toMoneyDto(report.totals.observedNet),
      unexplained: toMoneyDto(report.totals.unexplained),
      unattributedCredits: report.unattributed.length,
    };
  },
};

const ExceptionQuery = RunScope.extend({
  status: z
    .enum(['confirmed', 'probable', 'ambiguous', 'unmatched'])
    .optional()
    .describe('Omit for everything'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

/** The work queue. Paginated, because a period can hold hundreds of these. */
const listExceptions: Tool = {
  name: 'list_exceptions',
  description:
    'Settlements needing attention, newest first. Filter by confidence band and page through with limit/offset. Returns ids to pass to explain_match.',
  input: ExceptionQuery,
  output: z
    .object({
      total: z.number().int(),
      returned: z.number().int(),
      exceptions: z.array(ReconciliationDto),
    })
    .or(z.object({ error: z.string() })),
  async run(input: z.infer<typeof ExceptionQuery>, model) {
    const runId = await resolved(input.runId, model);
    if (!runId) return { error: `no run ${input.runId}` };

    const all = await model.flow.listReconciliations({
      runId,
      ...(input.status ? { status: input.status } : {}),
    });
    const page = all.slice(input.offset, input.offset + input.limit);

    return {
      total: all.length,
      returned: page.length,
      exceptions: page.map(toReconciliationDto),
    };
  },
};

const MatchRef = RunScope.extend({ matchId: z.string() });

const explainMatch: Tool = {
  name: 'explain_match',
  description:
    'Everything behind one settlement result: which checks passed and failed, the weight each carried, the confidence band, the window considered, and the candidates that were discarded with the reason each lost. Pass the same runId you listed it from: a match id is stable across runs, so it names a pairing rather than a result.',
  input: MatchRef,
  output: ReconciliationDto.or(z.object({ error: z.string() })),
  async run(input: z.infer<typeof MatchRef>, model) {
    const runId = await resolved(input.runId, model);
    if (!runId) return { error: `no run ${input.runId}` };

    const match = await model.flow.findReconciliation(runId, input.matchId);
    if (!match) return { error: `no match ${input.matchId} in run ${runId}` };
    return toReconciliationDto(match);
  },
};

const MovementRef = z.object({ movementId: z.string() });

const traceMovement: Tool = {
  name: 'trace_movement',
  description:
    'The lineage of one payment: the charge, the batch it settled in, the bank credit that paid it, and the raw record it was parsed from, with the locator inside that document.',
  input: MovementRef,
  output: z.unknown(),
  async run(input: z.infer<typeof MovementRef>, model) {
    const lineage = await model.ledger.lineageOf(input.movementId);
    if (!lineage) return { error: `no movement ${input.movementId}` };
    return toLineageDto(lineage);
  },
};

const listUnattributedCredits: Tool = {
  name: 'list_unattributed_credits',
  description:
    'Bank credits no settlement claimed. Not errors — interest, an unrelated transfer, a payer we do not track — but every one of them is money that arrived without an explanation.',
  input: RunScope.extend({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z
    .object({ total: z.number().int(), credits: z.array(UnattributedCreditDto) })
    .or(z.object({ error: z.string() })),
  async run(input: z.infer<typeof RunScope> & { limit: number }, model) {
    const runId = await resolved(input.runId, model);
    if (!runId) return { error: `no run ${input.runId}` };

    const report = await model.flow.flowReport(runId);
    const credits = report?.unattributed ?? [];

    return {
      total: credits.length,
      credits: credits.slice(0, input.limit).map(toUnattributedCreditDto),
    };
  },
};

const ErpQuery = RunScope.extend({
  journalKey: z.enum(['wompi', 'bancolombia']),
});

const getErpDiscrepancies: Tool = {
  name: 'get_erp_discrepancies',
  description:
    'Phase 3 for one journal: our ledger against Odoo, line by line, each discrepancy carrying the entry that would correct it. Read-only — nothing here posts anything.',
  input: ErpQuery,
  output: ErpReconciliationDto.or(z.object({ error: z.string() })),
  async run(input: z.infer<typeof ErpQuery>, model) {
    const runId = await resolved(input.runId, model);
    if (!runId) return { error: `no run ${input.runId}` };

    const report = await model.erp.erpReconciliation({
      journalKey: input.journalKey,
      runId,
    });
    if (!report) return { error: `no ERP reconciliation for ${input.journalKey}` };
    return toErpReconciliationDto(report, model.accountMap);
  },
};

/**
 * The vocabulary itself, so an agent cites a code instead of inventing a
 * category. Without this a model asked to summarise findings will coin its own
 * taxonomy, and two runs will not be comparable.
 */
const getEvidenceCodes: Tool = {
  name: 'get_evidence_codes',
  description:
    'The closed list of evidence codes every conclusion in this system is explained with, and the dimension each belongs to. Cite these rather than describing a finding in your own words.',
  input: z.object({}),
  output: z.object({
    codes: z.array(z.object({ code: EvidenceCodeDto, dimension: z.string() })),
  }),
  async run() {
    return {
      codes: EVIDENCE_CODES.map((code) => ({ code, dimension: EVIDENCE_DIMENSIONS[code] })),
    };
  },
};

const findMovement: Tool = {
  name: 'find_movement',
  description: 'One movement by id, with its amount, date, type and source reference.',
  input: MovementRef,
  output: MovementDto.or(z.object({ error: z.string() })),
  async run(input: z.infer<typeof MovementRef>, model) {
    const movement = await model.ledger.findMovement(input.movementId);
    if (!movement) return { error: `no movement ${input.movementId}` };
    return toMovementDto(movement);
  },
};

export const TOOLS: readonly Tool[] = [
  getRunSummary,
  listExceptions,
  explainMatch,
  traceMovement,
  findMovement,
  listUnattributedCredits,
  getErpDiscrepancies,
  getEvidenceCodes,
];

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
