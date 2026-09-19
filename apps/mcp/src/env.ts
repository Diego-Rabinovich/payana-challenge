import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppConfig } from '@aa/adapters';

/**
 * The MCP server reads the same sources as the CLI and serves no HTTP, so it
 * needs the same variables and none of the API's. Same reasoning as the CLI's
 * copy: a shared schema would force each app to care about settings it does
 * not have.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    return value;
  };

  return {
    mode: source['SOURCE_MODE'] === 'live' ? 'live' : 'fixtures',
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
