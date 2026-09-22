import { Temporal } from '@js-temporal/polyfill';
import {
  type Account,
  type ErpReconciliationReport,
  LATEST_RUN,
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
  correlate,
  traceMovement,
} from '@aa/core';
import { reviveErpReport, reviveFlowReport } from './persistence/revive.js';
import { describeChannel } from './presentation/channel-calibration.js';
import { renderMarkdown } from './presentation/markdown-report.js';
import { toRunReportDto } from './presentation/run-report.presenter.js';
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
  const { channelAccounts, journalAccounts } = deps;
  // El canal de quien no dice cuál: el primero del ruleset. Con uno solo, todo
  // se comporta como antes.
  const defaultChannel = ruleSet.channelKeys[0] ?? 'wompi';
  /** El canal cuya cuenta es esa, o ninguno si es el banco u otra cosa. */
  const channelOfAccount = (accountId: string): string | undefined =>
    Object.keys(channelAccounts).find((key) => channelAccounts[key] === accountId);
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
  /**
   * El reporte de fase 2 de una corrida. Ya no hay «la más reciente» implícita.
   *
   * Quien quiera la última la pide por su nombre —`latest`— y `resolve` la
   * convierte en un id concreto antes de que nadie lea nada. Un default mudo
   * acá significaba que pedir el detalle de un resultado de una corrida vieja
   * contestaba con los números de otra, o con un 404 sobre algo que estaba
   * guardado.
   */
  const flowOf = async (
    runId: string,
    channel: string = defaultChannel,
  ): Promise<ReconciliationReport | undefined> => {
    const stored = await repositories.reports.load<unknown>(asRunId(runId), 'flow', channel);
    return stored ? reviveFlowReport(stored) : undefined;
  };

  /** `latest` al id de la corrida más nueva; cualquier otro, si existe. */
  const resolveRun = async (runId: string): Promise<string | undefined> => {
    if (runId !== LATEST_RUN) {
      const found = await repositories.runs.findById(asRunId(runId));
      return found?.id;
    }
    const [newest] = await repositories.runs.list(1);
    return newest?.id;
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

      correlationOf: async (channelMovementId, bankMovementId) => {
        const [charge, credit] = await Promise.all([
          repositories.movements.findById(asMovementId(channelMovementId)),
          repositories.movements.findById(asMovementId(bankMovementId)),
        ]);
        if (!charge || !credit) return undefined;

        // El ledger es acumulativo y no pertenece a ninguna corrida, pero
        // para decir *por qué* dos movimientos están relacionados hace falta
        // un resultado, y el más útil es el de la corrida más reciente.
        const latest = await resolveRun(LATEST_RUN);
        const channel = channelOfAccount(charge.accountId);
        const batch = channel
          ? (await currentBatches(channel)).find((candidate) =>
              candidate.chargeIds.includes(charge.id),
            )
          : undefined;
        const match =
          batch && latest
            ? (await flowOf(latest, channel))?.matches.find((m) => m.left.batchId === batch.id)
            : undefined;

        return correlate({
          charge,
          credit,
          charges: batch ? await chargesOf(batch) : [],
          ...(batch ? { batch } : {}),
          ...(match ? { match } : {}),
        });
      },

      findMovements: async (ids) => {
        const found = await Promise.all(
          ids.map((id) => repositories.movements.findById(asMovementId(id))),
        );
        return found.filter((movement): movement is Movement => movement !== undefined);
      },

      lineageOf: async (movementId) => buildLineage(movementId),
    },

    flow: {
      // Los lotes se reconstruyen del ledger, que es determinístico, y se
      // recortan al período que esa corrida pidió: los lotes de marzo no son
      // parte de una corrida de enero a febrero.
      listBatches: async (runId, channel) => batchesOf(runId, channel),
      findBatch: async (runId, batchId, channel) =>
        (await batchesOf(runId, channel)).find((batch) => batch.id === batchId),

      listReconciliations: async ({ status, runId, channel }) => {
        const report = await flowOf(runId, channel);
        const matches = report?.matches ?? [];
        if (!status) return matches;

        // The wire says `ambiguous`, a MatchStatus says `AMBIGUOUS`. Comparing
        // them directly returned an empty list for every filter, which read as
        // "nothing to review" rather than as a bug.
        const wanted = status.toUpperCase();
        return matches.filter((match) => match.status.toUpperCase() === wanted);
      },

      findReconciliation: async (runId, matchId, channel) =>
        (await flowOf(runId, channel))?.matches.find((match) => match.id === matchId),

      flowReport: async (runId, channel) => flowOf(runId, channel),
    },

    erp: {
      erpReconciliation: async ({ journalKey, runId }) => {
        const stored = await repositories.reports.load<unknown>(
          asRunId(runId),
          'erp',
          journalKey,
        );
        return stored ? reviveErpReport(stored) : undefined;
      },
    },

    corrections: {
      create: async ({ journalKey, ref, runId }) => {
        const stored = await repositories.reports.load<unknown>(
          asRunId(runId),
          'erp',
          journalKey,
        );
        if (!stored) throw new Error(`No hay conciliación del diario ${journalKey}`);

        // La corrección se toma del reporte, no de lo que mandó el cliente.
        const report = reviveErpReport(stored);
        const line = report.lines.find((candidate) => candidate.correction?.ref === ref);
        if (!line?.correction) throw new Error(`No hay una corrección con referencia ${ref}`);
        if (line.correction.readOnly) {
          throw new Error('Esa corrección es sólo para mostrar: no se escribe en Odoo');
        }

        return deps.erp.createDraftEntry(line.correction);
      },

      remove: async (ref) => deps.erp.deleteDraftEntry(ref),

      written: async (journalKey) => {
        const journal = accountMap.journal(journalKey);
        if (!journal) throw new Error(`No hay un diario ${journalKey} en el plan de cuentas`);
        return deps.erp.listOwnEntries(journal.id);
      },
    },

    channels: {
      list: async (runId) =>
        Promise.all(
          ruleSet.channelKeys.map(async (key) => {
            const report = await flowOf(runId, key);
            return describeChannel(key, ruleSet, report?.matches ?? [], report?.calibration);
          }),
        ),
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
      resolve: async (runId) => resolveRun(runId),
      start: async ({ from, to }) => runPipeline(from, to),
      reportArtifact: async (runId, format) => {
        // El artefacto todavía cuenta un solo canal de la fase 2: el primero.
        const flow = await flowOf(runId);
        if (!flow) return undefined;

        const erp: Record<string, ErpReconciliationReport> = {};
        for (const journal of Object.keys(journalAccounts)) {
          const saved = await repositories.reports.load<unknown>(asRunId(runId), 'erp', journal);
          if (saved) erp[journal] = reviveErpReport(saved);
        }

        // Las dos salen de acá: la CLI escribe a disco lo mismo que descarga la
        // consola, así que el archivo y la descarga no pueden divergir. Y las
        // dos traen las dos fases.
        if (format === 'md') return renderMarkdown(flow, erp);

        // El JSON son los DTOs de la API, con las dos fases y la rúbrica.
        const run = await repositories.runs.findById(asRunId(runId));
        if (!run) return undefined;

        const report = toRunReportDto({
          run: toRunRecord(run),
          flow,
          erp,
          ruleSet,
          accountMap,
        });
        return JSON.stringify(report, null, 2);
      },
    },
  };

  // —— Helpers

  /**
   * Los lotes de un canal, armados con su propia política —corte, cadencia,
   * ventana—, que es la misma que usó la conciliación. Sin ella salían con el
   * corte a medianoche y no coincidían con los lotes que la corrida concilió.
   */
  async function currentBatches(channel: string = defaultChannel): Promise<SettlementBatch[]> {
    const accountId = channelAccounts[channel];
    if (!accountId) return [];
    const movements = await repositories.movements.findByAccount(accountId);
    return buildSettlementBatches({
      calendar,
      accountId,
      movements,
      policy: ruleSet.settlementPolicyFor(channel),
    });
  }

  /**
   * Los lotes que esa corrida vio.
   *
   * Se reconstruyen del ledger —`buildSettlementBatches` es determinístico— y
   * se recortan al rango que la corrida pidió. Sin el recorte, una corrida de
   * enero a febrero listaría lotes de abril que nunca miró.
   */
  async function batchesOf(runId: string, channel?: string): Promise<SettlementBatch[]> {
    const run = await repositories.runs.findById(asRunId(runId));
    const all = await currentBatches(channel);
    if (!run) return [];

    const { from, to } = run.range;
    return all.filter(
      (batch) => batch.batchDate.toString() >= from && batch.batchDate.toString() <= to,
    );
  }

  async function buildLineage(movementId: string): Promise<Lineage | undefined> {
    const charge = await repositories.movements.findById(asMovementId(movementId));
    if (!charge) return undefined;

    const channel = channelOfAccount(charge.accountId);
    if (!channel) return undefined;
    const batches = await currentBatches(channel);
    const batch = batches.find((candidate) => candidate.chargeIds.includes(charge.id));
    if (!batch) return undefined;

    const charges = await chargesOf(batch);
    const latest = await resolveRun(LATEST_RUN);
    const match = latest
      ? (await flowOf(latest, channel))?.matches.find((m) => m.left.batchId === batch.id)
      : undefined;
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

    await repositories.runs.create({
      id: runId,
      startedAt,
      rulesetVersion: ruleSet.version,
      from,
      to,
    });

    for (const sourceId of deps.connectors.ids()) {
      await useCases.ingest.execute({ sourceId, range, runId });
    }

    // Fase 2, una vez por canal del ruleset que tenga una fuente registrada.
    const flows: Record<string, ReconciliationReport> = {};
    for (const channel of ruleSet.channelKeys) {
      const gatewayAccountId = channelAccounts[channel];
      if (!gatewayAccountId) continue;

      const flowReport = await useCases.reconcileFlow.execute({
        gatewayAccountId,
        bankAccountId: accounts.bank,
        channel,
        range,
        runId,
      });
      await repositories.reports.save({
        runId,
        kind: 'flow',
        scope: channel,
        rulesetVersion: ruleSet.version,
        report: flowReport,
      });
      flows[channel] = flowReport;
    }

    for (const [journalKey, accountId] of Object.entries(journalAccounts)) {
      const journal = accountMap.journal(journalKey);
      if (!journal) continue;

      // Sólo el diario de un canal recibe sus liquidaciones: ahí van las
      // deducciones de cada una. La fase 2 ya terminó; esto la lee, no la cambia.
      const settlements = flows[journalKey]?.matches;
      const erpReport = await useCases.reconcileErp.execute({
        accountId,
        journalKey,
        range,
        runId,
        ...(settlements ? { settlements } : {}),
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

function toRunRecord(run: {
  id: string;
  startedAt: string;
  finishedAt?: string;
  rulesetVersion: string;
  range: { from: string; to: string };
}): RunRecord {
  return {
    id: run.id,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    rulesetVersion: run.rulesetVersion,
    range: run.range,
    inputHashes: {},
  };
}

/** Matches are served from a stored report, so the type is re-exported for the API. */
export type { MatchResult };