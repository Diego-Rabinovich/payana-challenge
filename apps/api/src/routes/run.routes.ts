import {
  CreateRunDto,
  EVIDENCE_CODES,
  EVIDENCE_DIMENSIONS,
  EvidenceCodeInfoDto,
  HealthDto,
  RunDto,
} from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../plugins/error-handler.js';
import type { ReadModel } from '@aa/core';

export const runRoutes =
  (deps: ReadModel): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/health',
      {
        schema: {
          tags: ['meta'],
          summary: 'Version, ruleset in force, and whether each source answered',
          response: { 200: HealthDto },
        },
      },
      async () => {
        const sources = await deps.health.sources();
        return {
          status: sources.every((source) => source.state === 'ready')
            ? ('ok' as const)
            : ('degraded' as const),
          version: deps.version,
          rulesetVersion: deps.rulesetVersion,
          sources: [...sources],
        };
      },
    );

    app.get(
      '/runs',
      {
        schema: {
          tags: ['runs'],
          summary: 'Past runs. They are never overwritten, only compared',
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
          response: { 200: z.object({ runs: z.array(RunDto) }) },
        },
      },
      async (request) => ({ runs: [...(await deps.runs.list(request.query.limit))] }),
    );

    app.post(
      '/runs',
      {
        schema: {
          tags: ['runs'],
          summary: 'Starts a run over a date range',
          body: CreateRunDto,
          response: { 201: RunDto },
        },
      },
      async (request, reply) => {
        const { from, to, sources } = request.body;
        const run = await deps.runs.start({ from, to, ...(sources ? { sources } : {}) });
        void reply.status(201).header('location', `/api/v1/runs/${run.id}`);
        return run;
      },
    );

    app.get(
      '/runs/:runId',
      {
        schema: {
          tags: ['runs'],
          params: z.object({ runId: z.string() }),
          response: { 200: RunDto },
        },
      },
      async (request) => {
        const run = await deps.runs.find(request.params.runId);
        if (!run) throw new NotFoundError(`Run ${request.params.runId}`);
        return run;
      },
    );

    app.get(
      '/runs/:runId/report',
      {
        schema: {
          tags: ['runs'],
          summary: 'The run artifact: Markdown for a person, JSON or NDJSON for a machine',
          params: z.object({ runId: z.string() }),
          querystring: z.object({ format: z.enum(['md', 'json', 'ndjson']).default('json') }),
        },
      },
      async (request, reply) => {
        const { format } = request.query;
        const artifact = await deps.runs.reportArtifact(request.params.runId, format);
        if (!artifact) throw new NotFoundError(`Report for run ${request.params.runId}`);

        const contentType =
          format === 'md'
            ? 'text/markdown; charset=utf-8'
            : format === 'ndjson'
              ? 'application/x-ndjson'
              : 'application/json';
        return reply.type(contentType).send(artifact);
      },
    );

    app.get(
      '/evidence-codes',
      {
        schema: {
          tags: ['meta'],
          summary: 'The closed vocabulary every conclusion is explained with',
          response: { 200: z.object({ codes: z.array(EvidenceCodeInfoDto) }) },
        },
      },
      // Served straight from the contract, which a test in this app pins to
      // the domain's own list — so what is published is what is emitted.
      async () => ({
        codes: EVIDENCE_CODES.map((code) => ({
          code,
          dimension: EVIDENCE_DIMENSIONS[code],
          meaning: `docs/EVIDENCE-CODES.md#${code.toLowerCase()}`,
        })),
      }),
    );
  };

