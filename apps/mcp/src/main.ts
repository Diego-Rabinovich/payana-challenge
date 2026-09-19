import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildDependencies, buildReadModel } from '@aa/adapters';
import { readEnv } from './env.js';
import { buildServer } from './server.js';

/**
 * stdio, because that is how an MCP client starts a server: it spawns the
 * process and talks over the pipe.
 *
 * Which means stdout belongs to the protocol. Anything logged there would be
 * read as a malformed message, so the one line we print goes to stderr.
 */
const VERSION = '0.1.0';

async function main(): Promise<void> {
  const deps = await buildDependencies(readEnv());
  const model = buildReadModel(deps, VERSION);

  await buildServer(model).connect(new StdioServerTransport());
  process.stderr.write(`conciliacion mcp ready · ruleset ${model.rulesetVersion}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
