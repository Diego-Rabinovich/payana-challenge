import type {
  AccountDto,
  ChannelDto,
  ErpReconciliationDto,
  HealthDto,
  LineageDto,
  MoneyDto,
  MovementDto,
  OffsetPageDto,
  ReconciliationDto,
  ReconciliationSummaryDto,
  RubricDto,
  RunDto,
  SettlementBatchDto,
  StatementFileDto,
  UnattributedCreditDto,
  WrittenEntryDto,
} from '@aa/contracts';

/**
 * The only channel between this app and the backend.
 *
 * Types come from `@aa/contracts`, the one package the frontend may import —
 * no domain, no adapters. Paths name resources, mirroring the API. See
 * ADR-0010.
 */
const BASE = import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:3100/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: { title?: string; detail?: string; code?: string },
  ) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    // Errors are RFC 9457, so a failure is as structured as a success and the
    // UI can say something specific instead of "algo salió mal".
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(response.status, problem);
  }
  return (await response.json()) as T;
}

const get = <T,>(path: string) => request<T>(path);

const post = <T,>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Every paged collection answers with the rows and where they sit in the whole. */
export interface Paged<T> {
  readonly rows: readonly T[];
  readonly page: OffsetPageDto;
}

export interface Window {
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export const api = {
  health: () => get<HealthDto>('/health'),

  /** The rubric, so the glossary never transcribes what the engine scores with. */
  rubric: () => get<RubricDto>('/evidence-codes'),

  summary: (runId?: string) =>
    get<ReconciliationSummaryDto>(`/reconciliation-summary${query({ runId })}`),

  accounts: () => get<{ accounts: AccountDto[] }>('/accounts'),

  /** Connected sources, their settings, and what the last run observed. */
  channels: (runId?: string) => get<{ channels: ChannelDto[] }>(`/channels${query({ runId })}`),

  movements: (accountId: string, params: Window = {}) =>
    get<{ movements: MovementDto[]; page: OffsetPageDto & { nextCursor: string | null } }>(
      `/accounts/${encodeURIComponent(accountId)}/movements${query({ ...params })}`,
    ),

  startRun: (body: { from: string; to: string }) => post<RunDto>('/runs', body),

  runs: (limit = 10) => get<{ runs: RunDto[] }>(`/runs${query({ limit })}`),

  statements: () => get<{ statements: StatementFileDto[] }>('/statements'),

  uploadStatement: (filename: string, contentBase64: string) =>
    post<StatementFileDto>('/statements', { filename, contentBase64 }),

  reconciliations: async (params: Window & { status?: string; runId?: string } = {}) => {
    const body = await get<{ reconciliations: ReconciliationDto[]; page: OffsetPageDto }>(
      `/reconciliations${query({ ...params })}`,
    );
    return { rows: body.reconciliations, page: body.page } satisfies Paged<ReconciliationDto>;
  },

  reconciliation: (matchId: string) => get<ReconciliationDto>(`/reconciliations/${matchId}`),

  /** The payments behind a settlement and the bank rows that paid it. */
  settlementMovements: (matchId: string) =>
    get<{
      charges: MovementDto[];
      credits: MovementDto[];
      rejected: { movement: MovementDto; score: number; rejectedBecause: string }[];
    }>(`/reconciliations/${matchId}/movements`),

  settlementBatches: async (params: Window & { runId?: string } = {}) => {
    const body = await get<{ batches: SettlementBatchDto[]; page: OffsetPageDto }>(
      `/settlement-batches${query({ ...params })}`,
    );
    return { rows: body.batches, page: body.page } satisfies Paged<SettlementBatchDto>;
  },

  unattributedCredits: async (
    params: Window & { runId?: string; channel?: 'wompi' | 'other' | 'all' } = {},
  ) => {
    const body = await get<{ credits: UnattributedCreditDto[]; page: OffsetPageDto }>(
      `/unattributed-credits${query({ ...params })}`,
    );
    return { rows: body.credits, page: body.page } satisfies Paged<UnattributedCreditDto>;
  },

  movement: (movementId: string) => get<MovementDto>(`/movements/${movementId}`),

  lineage: (movementId: string) => get<LineageDto>(`/movements/${movementId}/lineage`),

  erpReconciliation: (journalKey: 'wompi' | 'bancolombia', params: { runId?: string } = {}) =>
    get<ErpReconciliationDto>(`/erp-reconciliations/${journalKey}${query({ ...params })}`),

  /**
   * Crea en Odoo la corrección de una línea, en borrador.
   *
   * Se manda la referencia, no el asiento: el servidor lo reconstruye desde su
   * propio reporte, así que este cliente no puede elegir cuenta ni monto.
   */
  createErpEntry: (body: { journalKey: 'wompi' | 'bancolombia'; ref: string; runId?: string }) =>
    post<{ entryId: string; ref: string }>('/erp-journal-entries', body),

  /**
   * Los asientos que este sistema ya dejó escritos en ese diario.
   *
   * Se pregunta en cada carga de la pantalla, así la marca de "esto ya lo
   * creaste" sigue estando después de recargar y desaparece sola si alguien
   * borró el asiento en Odoo.
   */
  erpWrittenEntries: async (journalKey: 'wompi' | 'bancolombia') => {
    const body = await get<{ entries: WrittenEntryDto[] }>(
      `/erp-journal-entries${query({ journalKey })}`,
    );
    return body.entries;
  },

  /** Deshace la anterior. Sólo funciona sobre un borrador que creó el sistema. */
  deleteErpEntry: (ref: string) =>
    request<{ removed: boolean }>(`/erp-journal-entries/${encodeURIComponent(ref)}`, {
      method: 'DELETE',
    }),

  /** The Markdown report, as text. The caller decides what to do with it. */
  reportMarkdown: async (runId: string): Promise<string> => {
    const response = await fetch(`${BASE}/runs/${runId}/report?format=md`);
    if (!response.ok) throw new ApiError(response.status, {});
    return response.text();
  },
};

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)] as [string, string]);
  return entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : '';
}

/** Amounts arrive preformatted, so the UI never reimplements the rule. */
export function show(money: MoneyDto | undefined | null): string {
  return money?.formatted ?? '—';
}
