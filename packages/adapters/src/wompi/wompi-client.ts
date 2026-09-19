import { SourceUnavailableError } from '@aa/core';

/**
 * Wompi's REST API, as it actually behaves.
 *
 * The listing endpoint is undocumented but real: a bare `GET /transactions`
 * answers 422 and names the parameters it wants. That is how `from_date`,
 * `until_date`, `page` and `page_size` were found, and why this client pages
 * rather than pretending a single lookup is enough.
 *
 * What the payload does *not* carry is the fee breakdown — no commission, no
 * VAT, no withholding, nested objects included. Only the gross. Deriving the
 * rest is Phase 2's job; see ADR-0013.
 */

export interface WompiTransaction {
  readonly id: string;
  readonly reference: string;
  readonly amount_in_cents: number;
  readonly currency: string;
  readonly status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'PENDING';
  readonly created_at: string;
  readonly finalized_at?: string | null;
  readonly payment_method_type?: string;
  readonly customer_email?: string;
}

export interface WompiPage {
  readonly data: readonly WompiTransaction[];
  readonly meta: { readonly page: number; readonly page_size: number; readonly total_results: number };
}

export interface WompiClientOptions {
  readonly baseUrl: string;
  readonly privateKey: string;
  /** The API caps this at 200. */
  readonly pageSize?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const MAX_PAGE_SIZE = 200;

export class WompiClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: WompiClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Every transaction in a date range, page by page.
   *
   * Yields pages rather than one array: a year of a busier merchant should
   * not have to fit in memory before the first record is written.
   */
  async *pages(from: string, until: string): AsyncGenerator<WompiPage> {
    const pageSize = Math.min(this.options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    let page = 1;
    let seen = 0;

    do {
      const body = await this.get<WompiPage>(
        `/transactions?from_date=${from}&until_date=${until}&page=${page}&page_size=${pageSize}`,
      );
      if (body.data.length === 0) return;

      yield body;
      seen += body.data.length;
      page += 1;
    } while (seen < (await this.totalFor(from, until)));
  }

  /** A single transaction by the merchant reference. Case-insensitive at Wompi's end. */
  async byReference(reference: string): Promise<WompiTransaction | undefined> {
    const body = await this.get<WompiPage>(
      `/transactions?reference=${encodeURIComponent(reference.toLowerCase())}`,
    );
    return body.data[0];
  }

  private totals = new Map<string, number>();

  private async totalFor(from: string, until: string): Promise<number> {
    const key = `${from}|${until}`;
    const cached = this.totals.get(key);
    if (cached !== undefined) return cached;

    const body = await this.get<WompiPage>(
      `/transactions?from_date=${from}&until_date=${until}&page=1&page_size=1`,
    );
    this.totals.set(key, body.meta.total_results);
    return body.meta.total_results;
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.options.privateKey}`, accept: 'application/json' },
      });
    } catch (cause) {
      throw new SourceUnavailableError('Wompi did not respond', { path, cause: String(cause) });
    }

    if (!response.ok) {
      // The validation error carries the parameter names, which is worth
      // surfacing rather than collapsing into "request failed".
      const detail = await response.text().catch(() => '');
      throw new SourceUnavailableError(`Wompi answered ${response.status}`, {
        path,
        detail: detail.slice(0, 400),
      });
    }
    return (await response.json()) as T;
  }
}
