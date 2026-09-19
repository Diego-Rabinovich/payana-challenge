import type { AccountMap } from '../domain/account-map.js';
import type { RuleSet } from '../domain/ruleset.js';
import type { Account } from '../domain/account.js';
import type { ErpReconciliationReport } from '../domain/erp-reconciliation.js';
import type { MatchResult, ReconciliationReport } from '../domain/match-result.js';
import type { Movement } from '../domain/movement.js';
import type { SettlementBatch } from '../domain/settlement-batch.js';
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
  lineageOf(movementId: string): Promise<Lineage | undefined>;
}

export interface FlowQueries {
  listBatches(runId?: string): Promise<readonly SettlementBatch[]>;
  findBatch(batchId: string): Promise<SettlementBatch | undefined>;
  listReconciliations(input: { runId?: string; status?: string }): Promise<readonly MatchResult[]>;
  findReconciliation(matchId: string): Promise<MatchResult | undefined>;
  flowReport(runId?: string): Promise<ReconciliationReport | undefined>;
}

export interface ErpQueries {
  erpReconciliation(input: {
    journalKey: string;
    runId?: string;
    status?: string;
  }): Promise<ErpReconciliationReport | undefined>;
}

export interface RunQueries {
  list(limit: number): Promise<readonly RunRecord[]>;
  find(runId: string): Promise<RunRecord | undefined>;
  /** Triggers a run. Returns the created record; the route decides the status code. */
  start(input: { from: string; to: string; sources?: readonly string[] }): Promise<RunRecord>;
  reportArtifact(runId: string, format: 'md' | 'json' | 'ndjson'): Promise<string | undefined>;
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
  readonly health: HealthQueries;
}
