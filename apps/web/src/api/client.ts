import type {
  AccountDto,
  ErpReconciliationDto,
  HealthDto,
  LineageDto,
  MoneyDto,
  MovementDto,
  ReconciliationDto,
  RunDto,
  SettlementBatchDto,
  UnattributedCreditDto,
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

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    // Errors are RFC 9457, so a failure is as structured as a success and the
    // UI can say something specific instead of "algo salió mal".
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(response.status, problem);
  }
  return (await response.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(response.status, problem);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => get<HealthDto>('/health'),

  accounts: () => get<{ accounts: AccountDto[] }>('/accounts'),

  movements: (accountId: string, params: { from?: string; to?: string; limit?: number } = {}) =>
    get<{ movements: MovementDto[]; page: { nextCursor: string | null; count: number } }>(
      `/accounts/${encodeURIComponent(accountId)}/movements${query({
        ...params,
        limit: params.limit ? String(params.limit) : undefined,
      })}`,
    ),

  startRun: (body: { from: string; to: string }) => post<RunDto>('/runs', body),

  reconciliations: (params: { status?: string; runId?: string } = {}) =>
    get<{ reconciliations: ReconciliationDto[] }>(`/reconciliations${query(params)}`),

  reconciliation: (matchId: string) => get<ReconciliationDto>(`/reconciliations/${matchId}`),

  settlementBatches: (params: { runId?: string } = {}) =>
    get<{ batches: SettlementBatchDto[] }>(`/settlement-batches${query(params)}`),

  unattributedCredits: (params: { runId?: string } = {}) =>
    get<{ credits: UnattributedCreditDto[] }>(`/unattributed-credits${query(params)}`),

  movement: (movementId: string) => get<MovementDto>(`/movements/${movementId}`),

  lineage: (movementId: string) => get<LineageDto>(`/movements/${movementId}/lineage`),

  erpReconciliation: (journalKey: 'wompi' | 'bancolombia', params: { runId?: string } = {}) =>
    get<ErpReconciliationDto>(`/erp-reconciliations/${journalKey}${query(params)}`),
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
