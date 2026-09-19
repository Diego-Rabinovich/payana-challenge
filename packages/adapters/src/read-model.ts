import { Temporal } from '@js-temporal/polyfill';
import {
  type Account,
  type ErpReconciliationReport,
  type Lineage,
  type MatchResult,
  type Movement,
  type ReadModel,
  type ReconciliationReport,
  type RunRecord,
  type SettlementBatch,
  buildSettlementBatches,
  movementId as asMovementId,
  runId as asRunId,
  traceMovement,
} from '@aa/core';
import { reviveErpReport, reviveFlowReport } from './persistence/revive.js';
import { renderMarkdown } from './presentation/markdown-report.js';
import { listStatements, saveStatement } from './fs/statement-inbox.js';
import type { Dependencies } from './composition.js';

/**
 * The read side, assembled from the repositories.
 *
 * Reconciliation results are stored whole and served from storage rather than
 * recomputed per request: a report is a statement about a period under one
 * ruleset version, and recomputing it would silently answer a question nobody
 * asked — "what would we conclude today?" instead of "what did we conclude".
 */
export function buildReadModel(deps: Dependencies, version: string): ReadModel {
  const { repositories, accounts, useCases, ruleSet, accountMap, calendar } = deps;
  // The same directory the file connector reads, so an uploaded statement is
  // picked up by the next run with no further plumbing.
  const statementDir = deps.statementDir;

  const accountList: Account[] = [
    { id: accounts.wompi, kind: 'GATEWAY', name: 'Wompi — Alimentos Alcázar', currency: 'COP' },
    {
      id: accounts.bank,
      kind: 'BANK',
      name: 'Bancolombia — Alimentos Alcázar SAS',
      currency: 'COP',
      externalRef: String(accounts.bank).split(':')[1] ?? '',
    },
  ];

  // Revived, not cast: what comes back from Postgres is JSON, and the domain
  // objects have to be rebuilt before anything calls a method on them.
  const latestFlow = async (): Promise<ReconciliationReport | undefined> => {
    const stored = await repositories.reports.latest<unknown>('flow', 'wompi');
    return stored ? reviveFlowReport(stored) : undefined;
  };

  return {
    version,
    rulesetVersion: ruleSet.version,
    accountMap,
    ruleSet,

    health: {
      sources: async () => [
        { id: 'wompi:transactions', mode: 'live', state: 'ready' },
        { id: 'bancolombia:statement', mode: 'fixtures', state: 'ready' },
        { id: 'odoo:journal-48', mode: 'live', state: 'ready' },
      ],
    },

    ledger: {
      listAccounts: async () => accountList,

      listMovements: async ({ accountId, window, cursor, offset, limit }) => {
        const all = await repositories.movements.findByAccount(
          accountId as Account['id'],
          window
            ? {
                from: Temporal.PlainDate.from(window.from),
                to: Temporal.PlainDate.from(window.to),
              }
            : undefined,
        );
        // A cursor is the last id seen, which is stable under inserts where an
        // offset is not; an offset is what lets a screen say "51-75 of 312".
        // Both are accepted, the cursor wins when present.
        const start = cursor
          ? all.findIndex((movement) => movement.id === cursor) + 1
          : (offset ?? 0);
        const page = all.slice(start, start + limit);
        return {
          items: page,
          nextCursor: start + limit < all.length ? (page.at(-1)?.id ?? null) : null,
          total: all.length,
        };
      },

      findMovement: (movementId) => repositories.movements.findById(asMovementId(movementId)),

      findMovements: async (ids) => {
        const found = await Promise.all(
          ids.map((id) => repositories.movements.findById(asMovementId(id))),
        );
        return found.filter((movement): movement is Movement => movement !== undefined);
      },

      lineageOf: async (movementId) => buildLineage(movementId),
    },

    flow: {
      listBatches: async () => currentBatches(),
      findBatch: async (batchId) => (await currentBatches()).find((batch) => batch.id === batchId),

      listReconciliations: async ({ status }) => {
        const report = await latestFlow();
        const matches = report?.matches ?? [];
        if (!status) return matches;

        // The wire says `ambiguous`, a MatchStatus says `AMBIGUOUS`. Comparing
        // them directly returned an empty list for every filter, which read as
        // "nothing to review" rather than as a bug.
        const wanted = status.toUpperCase();
        return matches.filter((match) => match.status.toUpperCase() === wanted);
      },

      findReconciliation: async (matchId) =>
        (await latestFlow())?.matches.find((match) => match.id === matchId),

      flowReport: async () => latestFlow(),
    },

    erp: {
      erpReconciliation: async ({ journalKey }) => {
        const stored = await repositories.reports.latest<unknown>('erp', journalKey);
        return stored ? reviveErpReport(stored) : undefined;
      },
    },

    statements: {
      list: async () => listStatements(statementDir),
      add: async ({ filename, content }) => saveStatement(statementDir, filename, content),
    },

    runs: {
      list: async (limit) => (await repositories.runs.list(limit)).map(toRunRecord),
      find: async (runId) => {
        const run = await repositories.runs.findById(asRunId(runId));
        return run ? toRunRecord(run) : undefined;
      },
      start: async ({ from, to }) => runPipeline(from, to),
      reportArtifact: async (runId, format) => {
        const stored = await repositories.reports.load<unknown>(asRunId(runId), 'flow', 'wompi');
        if (!stored) return undefined;

        // JSON goes out as stored; Markdown is rendered from the revived
        // report by the same function the CLI writes to disk, so the download
        // and the file cannot drift apart.
        if (format === 'json') return JSON.stringify(stored, null, 2);
        if (format === 'md') return renderMarkdown(reviveFlowReport(stored));
        return undefined;
      },
    },
  };

  // —— Helpers

  async function currentBatches(): Promise<SettlementBatch[]> {
    const movements = await repositories.movements.findByAccount(accounts.wompi);
    return buildSettlementBatches({ calendar, accountId: accounts.wompi, movements });
  }

  async function buildLineage(movementId: string): Promise<Lineage | undefined> {
    const charge = await repositories.movements.findById(asMovementId(movementId));
    if (!charge) return undefined;

    const batches = await currentBatches();
    const batch = batches.find((candidate) => candidate.chargeIds.includes(charge.id));
    if (!batch) return undefined;

    const charges = await chargesOf(batch);
    const match = (await latestFlow())?.matches.find((m) => m.left.batchId === batch.id);
    // The first credit is the one a lineage view follows; a split settlement
    // is shown in full on the reconciliation screen, not here.
    const settlingId = match?.right?.movementIds[0];
    const credit = settlingId ? await repositories.movements.findById(settlingId) : undefined;

    return traceMovement({
      charge,
      batch,
      charges,
      ...(match ? { match } : {}),
      ...(credit ? { bankCredit: credit } : {}),
    });
  }

  async function chargesOf(batch: SettlementBatch): Promise<Movement[]> {
    const all = await repositories.movements.findByAccount(batch.accountId);
    return all.filter((movement) => batch.chargeIds.includes(movement.id));
  }

  /**
   * One run: ingest every source, reconcile both phases, store the results.
   *
   * The results are persisted rather than returned only, because a run is not
   * a request — it is the thing every later question is asked about.
   */
  async function runPipeline(from: string, to: string): Promise<RunRecord> {
    const startedAt = Temporal.Now.instant().toString();
    const runId = asRunId(`run_${startedAt.replace(/[^0-9]/g, '').slice(0, 14)}`);
    const range = { from: Temporal.PlainDate.from(from), to: Temporal.PlainDate.from(to) };

    await repositories.runs.create({ id: runId, startedAt, rulesetVersion: ruleSet.version });

    for (const sourceId of [deps.sources.wompi, deps.sources.bank]) {
      await useCases.ingest.execute({ sourceId, range, runId });
    }

    const flowReport = await useCases.reconcileFlow.execute({
      gatewayAccountId: accounts.wompi,
      bankAccountId: accounts.bank,
      channel: 'wompi',
      range,
      runId,
    });
    await repositories.reports.save({
      runId,
      kind: 'flow',
      scope: 'wompi',
      rulesetVersion: ruleSet.version,
      report: flowReport,
    });

    for (const journalKey of ['wompi', 'bancolombia'] as const) {
      const journal = accountMap.journal(journalKey);
      if (!journal) continue;

      const erpReport = await useCases.reconcileErp.execute({
        accountId: journalKey === 'wompi' ? accounts.wompi : accounts.bank,
        journalKey,
        range,
        runId,
      });
      await repositories.reports.save({
        runId,
        kind: 'erp',
        scope: journalKey,
        rulesetVersion: ruleSet.version,
        report: erpReport,
      });
    }

    void calendar;
    return {
      id: runId,
      startedAt,
      finishedAt: Temporal.Now.instant().toString(),
      rulesetVersion: ruleSet.version,
      range: { from, to },
      inputHashes: {},
    };
  }
}

function toRunRecord(run: { id: string; startedAt: string; rulesetVersion: string }): RunRecord {
  return {
    id: run.id,
    startedAt: run.startedAt,
    rulesetVersion: run.rulesetVersion,
    range: { from: '1970-01-01', to: '1970-01-01' },
    inputHashes: {},
  };
}

/** Matches are served from a stored report, so the type is re-exported for the API. */
export type { MatchResult };