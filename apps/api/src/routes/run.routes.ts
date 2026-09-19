import {
  CreateRunDto,
  EVIDENCE_CODES,
  EVIDENCE_DIMENSIONS,
  type EvidenceCode,
  HealthDto,
  RubricDto,
  RunDto,
  StatementFileDto,
  UploadStatementDto,
} from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError, RejectedError } from '../plugins/error-handler.js';
import type { ReadModel } from '@aa/core';
import { attainableScore } from '@aa/core';

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
      '/statements',
      {
        schema: {
          tags: ['runs'],
          summary: 'Bank statements the next run will read',
          response: { 200: z.object({ statements: z.array(StatementFileDto) }) },
        },
      },
      async () => ({ statements: [...(await deps.statements.list())] }),
    );

    app.post(
      '/statements',
      {
        // A statement is a few hundred kilobytes; base64 inflates it by a
        // third. The default 1 MB body limit rejects a perfectly ordinary
        // April statement, which looks like a bug and is not one.
        bodyLimit: 20 * 1024 * 1024,
        schema: {
          tags: ['runs'],
          summary: 'Uploads a Bancolombia statement for the next run to ingest',
          body: UploadStatementDto,
          response: { 201: StatementFileDto },
        },
      },
      async (request, reply) => {
        const { filename, contentBase64 } = request.body;
        const content = new Uint8Array(Buffer.from(contentBase64, 'base64'));

        try {
          const stored = await deps.statements.add({ filename, content });
          void reply.status(201);
          return stored;
        } catch (cause) {
          // "This is not a PDF" is the user's problem to fix, not a fault.
          throw new RejectedError(cause instanceof Error ? cause.message : 'Archivo rechazado');
        }
      },
    );

    app.get(
      '/evidence-codes',
      {
        schema: {
          tags: ['meta'],
          summary: 'The closed vocabulary and the weight of each code. The rubric itself',
          response: { 200: RubricDto },
        },
      },
      // Served from the contract and the live ruleset rather than from a page
      // someone maintains by hand: a weight that changes in config changes
      // here on the next request, so the glossary cannot go stale.
      async () => {
        const { weights, exclusiveDimensions, bands, ambiguityDelta, disqualifying } =
          deps.ruleSet.config;

        const groupOf = (code: string) =>
          Object.values(exclusiveDimensions).find((codes) =>
            (codes as readonly string[]).includes(code),
          ) ?? [];

        return {
          rulesetVersion: deps.rulesetVersion,
          attainable: attainableScore(deps.ruleSet.scoring),
          bands,
          ambiguityDelta,
          codes: EVIDENCE_CODES.map((code) => ({
            code,
            dimension: EVIDENCE_DIMENSIONS[code],
            ...(weights[code] !== undefined ? { weight: weights[code] } : {}),
            disqualifying: (disqualifying ?? []).includes(code),
            exclusiveWith: (groupOf(code) as readonly EvidenceCode[]).filter(
              (other) => other !== code,
            ),
            meaning: code,
          })),
        };
      },
    );
  };

