import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppConfig } from '@aa/adapters';

/**
 * The CLI needs fewer variables than the API — no port, no CORS — so it
 * validates its own set rather than sharing a schema that would force it to
 * care about things it does not use.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    return value;
  };

  return {
    dataDir: fromRepoRoot(source['DATA_DIR'] ?? './data'),
    configDir: fromRepoRoot(source['CONFIG_DIR'] ?? './config'),
    databaseUrl: required('DATABASE_URL'),
    bancolombiaAccountNumber: required('BANCOLOMBIA_ACCOUNT_NUMBER'),
    wompi: {
      baseUrl: source['WOMPI_BASE_URL'] ?? 'https://production.wompi.co/v1',
      privateKey: source['WOMPI_PRIVATE_KEY'] ?? '',
    },
    odoo: {
      url: source['ODOO_URL'] ?? '',
      database: source['ODOO_DB'] ?? '',
      userId: Number(source['ODOO_USER_ID'] ?? 0),
      apiKey: source['ODOO_API_KEY'] ?? '',
      companyId: Number(source['ODOO_COMPANY_ID'] ?? 0),
      writeEnabled: source['ODOO_WRITE_ENABLED'] === 'true',
    },
  };
}

/**
 * Relative paths in the environment mean "from the repository root".
 *
 * A workspace command runs with the package as cwd, so `./config` would
 * resolve differently depending on which app started — the kind of difference
 * that shows up as a missing file on someone else's machine.
 */
function fromRepoRoot(path: string): string {
  if (isAbsolute(path)) return path;

  let dir = process.cwd();
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(path);
    dir = parent;
  }
  return resolve(dir, path);
}
