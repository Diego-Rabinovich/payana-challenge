import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerErrorHandler } from './plugins/error-handler.js';
import type { ReadModel } from '@aa/core';
import { ledgerRoutes } from './routes/ledger.routes.js';
import { reconciliationRoutes } from './routes/reconciliation.routes.js';
import { runRoutes } from './routes/run.routes.js';

export const API_PREFIX = '/api/v1';

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly corsOrigin?: string;
}

/**
 * The HTTP layer, and nothing more.
 *
 * Routes validate, call a query port and hand the result to a presenter. No
 * business decision is taken here; the dependencies arrive already assembled,
 * which is what lets the same use cases serve the CLI unchanged.
 *
 * Declaring a response schema is not documentation: Fastify compiles it into
 * the serialiser, so a domain field a presenter forgot to drop never reaches
 * the wire. The boundary of ADR-0010 is enforced at runtime here, on top of
 * the lint rule that enforces it at build time.
 */
export async function buildApp(
  deps: ReadModel,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(cors, { origin: options.corsOrigin ?? true });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Alimentos Alcázar — reconciliation',
        version: deps.version,
        description:
          'Two consumers, one contract: a CFO reading a report and an AI reasoning over the same ' +
          'results. Every conclusion carries its evidence, and every result carries the ruleset ' +
          'version that produced it.',
      },
      servers: [{ url: API_PREFIX }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Correlating logs by run is what makes a past result explainable later.
  app.addHook('onRequest', async (request) => {
    const runId = request.headers['x-run-id'];
    if (typeof runId === 'string') request.log = request.log.child({ runId });
  });

  await app.register(
    async (api) => {
      await api.register(runRoutes(deps));
      await api.register(ledgerRoutes(deps.ledger));
      await api.register(
        reconciliationRoutes(deps.flow, deps.erp, deps.ledger, deps.accountMap, deps.ruleSet),
      );
    },
    { prefix: API_PREFIX },
  );

  return app;
}
