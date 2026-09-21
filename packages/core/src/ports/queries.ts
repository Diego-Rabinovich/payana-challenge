import type { AccountMap } from '../domain/account-map.js';
import type { OwnEntry } from './erp-gateway.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { Account } from '../domain/account.js';
import type { ErpReconciliationReport } from '../domain/erp-reconciliation.js';
import type { MatchResult, ReconciliationReport } from '../domain/match-result.js';
import type { Movement } from '../domain/movement.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
import type { RateCalibration } from '../domain/rate-calibration.js';
import type { Correlation } from '../usecases/correlate.js';
import type { Lineage } from '../usecases/trace-movement.js';

/**
 * The read side, split by resource.
 *
 * Four narrow ports rather than one wide one: a route that serves movements
 * has no business being able to post journal entries, and a fake for one test
 * should not have to stub twelve methods it never calls. Interface segregation
 * is cheap here and it keeps each route file honest about its dependencies.
 *
 * They live here rather than in one delivery app because there is more than
 * one reader: the HTTP API and the MCP server answer the same questions and
 * must answer them identically. The composition root satisfies them from the
 * repositories, so no consumer knows whether an answer came from Postgres, a
 * fixture or a live gateway.
 */

export interface DateWindow {
  readonly from: string;
  readonly to: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  /**
   * How many there are in total.
   *
   * A cursor alone tells a reader whether there is more, never how much more,
   * and "movimientos 1–50" with no denominator is the kind of screen people
   * scroll forever without knowing they have.
   */
  readonly total: number;
}

export interface LedgerQueries {
  listAccounts(): Promise<readonly Account[]>;
  listMovements(input: {
    accountId: string;
    window?: DateWindow;
    cursor?: string;
    offset?: number;
    limit: number;
  }): Promise<Page<Movement>>;
  findMovement(movementId: string): Promise<Movement | undefined>;
  /**
   * The brief's first primitive: are these two movements related, and why?
   * Undefined when either id does not exist.
   */
  correlationOf(
    channelMovementId: string,
    bankMovementId: string,
  ): Promise<Correlation | undefined>;
  /** Several at once, for a screen that has a list of ids and needs the rows. */
  findMovements(ids: readonly string[]): Promise<readonly Movement[]>;
  lineageOf(movementId: string): Promise<Lineage | undefined>;
}

/**
 * Todo lo de acá es la conclusión de una corrida, así que todo pide cuál.
 *
 * El `runId` era opcional y ausente significaba «la más reciente». Eso hacía
 * que un id de match —que es estable entre corridas a propósito, para que un
 * rerun actualice en vez de duplicar— no identificara un resultado sino una
 * familia de resultados, desambiguada por cuál corrió último. Un detalle
 * guardado en una corrida vieja daba 404 mientras la lista de esa misma
 * corrida lo mostraba.
 *
 * Quien quiera «la última» pide `latest` y `RunQueries.resolve` le devuelve el
 * id concreto, que después viaja en la respuesta. Lo implícito se volvió
 * explícito sin perder el atajo.
 */
export interface FlowQueries {
  listBatches(runId: string): Promise<readonly SettlementBatch[]>;
  findBatch(runId: string, batchId: string): Promise<SettlementBatch | undefined>;
  listReconciliations(input: { runId: string; status?: string }): Promise<readonly MatchResult[]>;
  findReconciliation(runId: string, matchId: string): Promise<MatchResult | undefined>;
  flowReport(runId: string): Promise<ReconciliationReport | undefined>;
}

export interface ErpQueries {
  erpReconciliation(input: {
    journalKey: string;
    runId: string;
    status?: string;
  }): Promise<ErpReconciliationReport | undefined>;
}

export const LATEST_RUN = 'latest';

export interface RunQueries {
  list(limit: number): Promise<readonly RunRecord[]>;
  find(runId: string): Promise<RunRecord | undefined>;
  /**
   * Convierte lo que pidió el cliente en un id concreto.
   *
   * `latest` se resuelve a la corrida más reciente; cualquier otra cosa se
   * devuelve sólo si esa corrida existe. Undefined significa 404, que es mejor
   * que contestar con los números de otra corrida.
   */
  resolve(runId: string): Promise<string | undefined>;
  /** Triggers a run. Returns the created record; the route decides the status code. */
  start(input: { from: string; to: string; sources?: readonly string[] }): Promise<RunRecord>;
  /**
   * El artefacto de una corrida: Markdown para una persona, JSON para una IA.
   * El JSON son los DTOs de la API; ver `RunReportDto`.
   */
  reportArtifact(runId: string, format: 'md' | 'json'): Promise<string | undefined>;
}

export interface RunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly rulesetVersion: string;
  readonly range: DateWindow;
  readonly inputHashes: Readonly<Record<string, string>>;
}

export interface SourceStatus {
  readonly id: string;
  readonly mode: 'fixtures' | 'live';
  readonly state: 'ready' | 'stale' | 'unavailable';
  readonly asOf?: string;
}

/**
 * A connected source: how it settles, and what the last run measured about it.
 *
 * `calibration` is read back from the run rather than recomputed, so what the
 * screen shows is exactly the band the score was awarded against. Absent when
 * too few settlements matched to say what is usual.
 */
export interface ChannelView {
  readonly key: string;
  readonly counterpartyPatterns: readonly string[];
  readonly cadence: string;
  readonly cutoff?: string;
  readonly window: { readonly fromBusinessDays: number; readonly toBusinessDays: number };
  /** The only band in configuration: a guard, not a grade. */
  readonly admissibleBand: readonly [number, number];
  readonly declaresOwnBand: boolean;
  /** True when the source states its deductions, so nothing had to be implied. */
  readonly reportsOwnDeductions: boolean;
  readonly settlements: number;
  readonly calibration?: RateCalibration;
  readonly observed?: { readonly lowest: number; readonly highest: number; readonly count: number };
}

/**
 * La única escritura del sistema, y vive acá para que se vea.
 *
 * El llamador manda una referencia, nunca un asiento: el servidor reconstruye
 * la corrección desde el reporte que él mismo produjo, así que un cliente no
 * puede dictar cuentas ni montos. Todo lo demás que protege esta operación
 * está en el adapter de Odoo, donde el alcance sale del plan de cuentas.
 */
export interface CorrectionWrites {
  /** Crea en borrador la corrección de esa línea. Devuelve el id de Odoo. */
  create(input: { journalKey: string; ref: string; runId: string }): Promise<string>;
  /** Deshace la anterior. Falso cuando no había nada que deshacer. */
  remove(ref: string): Promise<boolean>;
  /**
   * Lo que dejamos escrito en ese diario, preguntado al ERP.
   *
   * La consola lo necesita para que la marca de "esto ya lo creaste"
   * sobreviva a recargar la página, sin inventarse un registro propio que
   * podría contradecir a Odoo.
   */
  written(journalKey: string): Promise<readonly OwnEntry[]>;
}

export interface ChannelQueries {
  list(runId: string): Promise<readonly ChannelView[]>;
}

/** A bank statement sitting in the inbox, whether or not a run has read it. */
export interface StatementFile {
  readonly name: string;
  readonly bytes: number;
  readonly receivedAt: string;
}

/**
 * The statement inbox.
 *
 * Phase 1 says a statement is an input someone provides, and until this
 * existed the only way to provide one was to copy a file into the repository
 * before starting the API — which meant the console showed a pipeline whose
 * first step happened somewhere the user could not see.
 */
export interface StatementQueries {
  list(): Promise<readonly StatementFile[]>;
  /** Stores it for the next run. Ingestion is idempotent on content hash. */
  add(input: { filename: string; content: Uint8Array }): Promise<StatementFile>;
}

export interface HealthQueries {
  sources(): Promise<readonly SourceStatus[]>;
}

/** Everything a delivery mechanism is handed. Assembled by the composition root. */
export interface ReadModel {
  readonly version: string;
  readonly rulesetVersion: string;
  /** Exposed so a delivery mechanism can name accounts without guessing them. */
  readonly accountMap: AccountMap;
  /** Same reason: whether a counterparty is the channel is policy, not UI logic. */
  readonly ruleSet: RuleSet;
  readonly ledger: LedgerQueries;
  readonly flow: FlowQueries;
  readonly erp: ErpQueries;
  readonly runs: RunQueries;
  readonly statements: StatementQueries;
  readonly channels: ChannelQueries;
  readonly corrections: CorrectionWrites;
  readonly health: HealthQueries;
}
