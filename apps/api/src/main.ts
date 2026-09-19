import { buildDependencies, buildReadModel } from '@aa/adapters';
import { buildApp } from './app.js';
import { readEnv } from './env.js';

/** Read the environment, assemble, serve. Twenty lines, by design. */
const env = readEnv();
const deps = await buildDependencies(env.app);
const app = await buildApp(buildReadModel(deps, '0.1.0'), { logger: true });

await app.listen({ port: env.port, host: '0.0.0.0' });
app.log.info(`reconciliation API on :${env.port} · docs at /docs`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await deps.close();
      process.exit(0);
    })();
  });
}
