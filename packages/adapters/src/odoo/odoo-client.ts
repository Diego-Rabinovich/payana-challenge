import { SourceUnavailableError } from '@aa/core';

/**
 * Odoo's external API over JSON-RPC.
 *
 * XML-RPC is the documented route and is on its way out; JSON-RPC needs no
 * extra dependency and speaks the same `execute_kw` protocol underneath. An
 * API key goes where the password would, so there is no separate
 * authentication round trip.
 *
 * Every call carries the company context: without it Odoo answers from
 * whichever companies the user happens to have enabled, which is a quietly
 * wrong answer rather than an error.
 */

export interface OdooClientOptions {
  readonly url: string;
  readonly database: string;
  readonly userId: number;
  readonly apiKey: string;
  readonly companyId: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class OdooClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: OdooClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  searchRead<T>(
    model: string,
    domain: readonly unknown[],
    fields: readonly string[],
    extra: Record<string, unknown> = {},
  ): Promise<T[]> {
    return this.call<T[]>(model, 'search_read', [domain], { fields, ...extra });
  }

  searchCount(model: string, domain: readonly unknown[]): Promise<number> {
    return this.call<number>(model, 'search_count', [domain]);
  }

  create(model: string, values: Record<string, unknown>): Promise<number> {
    return this.call<number>(model, 'create', [values]);
  }

  async call<T>(
    model: string,
    method: string,
    args: readonly unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      method: 'call',
      id: Date.now(),
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          this.options.database,
          this.options.userId,
          this.options.apiKey,
          model,
          method,
          args,
          { context: { allowed_company_ids: [this.options.companyId] }, ...kwargs },
        ],
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.url}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new SourceUnavailableError('Odoo did not respond', { model, method, cause: String(cause) });
    }

    const payload = (await response.json()) as { result?: T; error?: OdooError };
    if (payload.error) {
      // Odoo returns 200 with an error body, so the status tells us nothing.
      throw new SourceUnavailableError(`Odoo refused ${model}.${method}`, {
        model,
        method,
        detail: payload.error.data?.message ?? payload.error.message ?? 'unknown',
      });
    }
    return payload.result as T;
  }
}

interface OdooError {
  readonly message?: string;
  readonly data?: { readonly message?: string };
}
