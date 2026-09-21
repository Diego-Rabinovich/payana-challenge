import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppConfig } from '@aa/adapters';
import { z } from 'zod';

/**
 * Reading the environment is this app's business; assembling adapters is not.
 *
 * The composition root takes a parsed `AppConfig` and never touches
 * `process.env` — which is what keeps the adapter ring free of deployment
 * concerns while each app validates only the variables it actually needs.
 * See ADR-0011.
 */
const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(3100),
  LOG_LEVEL: z.string().default('info'),
  DATA_DIR: z.string().default('./data'),
  CONFIG_DIR: z.string().default('./config'),
  DATABASE_URL: z.string(),
  BANCOLOMBIA_ACCOUNT_NUMBER: z.string(),
  WOMPI_BASE_URL: z.string().default('https://production.wompi.co/v1'),
  WOMPI_PRIVATE_KEY: z.string().default(''),
  ODOO_URL: z.string().default(''),
  ODOO_DB: z.string().default(''),
  ODOO_USER_ID: z.coerce.number().int().default(0),
  ODOO_API_KEY: z.string().default(''),
  ODOO_COMPANY_ID: z.coerce.number().int().default(0),
  ODOO_WRITE_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  VITE_API_BASE_URL: z.string().optional(),
});

export interface ApiEnv {
  readonly port: number;
  readonly logLevel: string;
  readonly corsOrigin: string | undefined;
  readonly app: AppConfig;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    // Fail at boot with the variable names, rather than at the first request
    // with a stack trace from inside a driver.
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${missing}`);
  }
  const env = parsed.data;

  return {
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigin: env.VITE_API_BASE_URL ? undefined : undefined,
    app: {
      dataDir: fromRepoRoot(env.DATA_DIR),
      configDir: fromRepoRoot(env.CONFIG_DIR),
      databaseUrl: env.DATABASE_URL,
      bancolombiaAccountNumber: env.BANCOLOMBIA_ACCOUNT_NUMBER,
      wompi: { baseUrl: env.WOMPI_BASE_URL, privateKey: env.WOMPI_PRIVATE_KEY },
      odoo: {
        url: env.ODOO_URL,
        database: env.ODOO_DB,
        userId: env.ODOO_USER_ID,
        apiKey: env.ODOO_API_KEY,
        companyId: env.ODOO_COMPANY_ID,
        writeEnabled: env.ODOO_WRITE_ENABLED,
      },
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
