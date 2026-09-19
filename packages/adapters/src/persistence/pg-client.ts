import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The Postgres connection, and the one place that knows the schema exists.
 *
 * Migrations are a single idempotent file rather than a numbered chain: the
 * schema is small, every statement is `if not exists`, and running it twice
 * is a no-op. A chain earns its complexity when columns start changing under
 * live data, which has not happened yet.
 */
export class PgClient {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async query<T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []) {
    return this.pool.query<T>(text, values as unknown[]);
  }

  /** Runs several statements atomically — an ingestion is all or nothing. */
  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    await this.pool.query(readFileSync(join(here, 'schema.sql'), 'utf8'));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
