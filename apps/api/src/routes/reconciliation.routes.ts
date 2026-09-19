import {
  ErpReconciliationDto,
  ReconciliationDto,
  SettlementBatchDto,
  UnattributedCreditDto,
} from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../plugins/error-handler.js';
import { toSettlementBatchDto } from '@aa/adapters';
import {
  toErpReconciliationDto,
  toReconciliationDto,
  toUnattributedCreditDto,
} from '@aa/adapters';
import type { AccountMap, ErpQueries, FlowQueries } from '@aa/core';

const StatusFilter = z
  .enum(['confirmed', 'probable', 'ambiguous', 'unmatched'])
  .optional()
  .describe('Filters the collection; omit for everything');

export const reconciliationRoutes =
  (flow: FlowQueries, erp: ErpQueries, accountMap: AccountMap): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/settlement-batches',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'A day of channel sales, with what it should have transferred',
          querystring: z.object({ runId: z.string().optional() }),
          response: { 200: z.object({ batches: z.array(SettlementBatchDto) }) },
        },
      },
      async (request) => ({
        batches: (await flow.listBatches(request.query.runId)).map(toSettlementBatchDto),
      }),
    );

    app.get(
      '/settlement-batches/:batchId',
      {
        schema: {
          tags: ['reconciliation'],
          params: z.object({ batchId: z.string() }),
          response: { 200: SettlementBatchDto },
        },
      },
      async (request) => {
        const batch = await flow.findBatch(request.params.batchId);
        if (!batch) throw new NotFoundError(`Batch ${request.params.batchId}`);
        return toSettlementBatchDto(batch);
      },
    );

    app.get(
      '/reconciliations',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'Channel-to-bank results; filter by status for the exception queue',
          querystring: z.object({ runId: z.string().optional(), status: StatusFilter }),
          response: { 200: z.object({ reconciliations: z.array(ReconciliationDto) }) },
        },
      },
      async (request) => ({
        reconciliations: (
          await flow.listReconciliations({
            ...(request.query.runId ? { runId: request.query.runId } : {}),
            ...(request.query.status ? { status: request.query.status.toUpperCase() } : {}),
          })
        ).map(toReconciliationDto),
      }),
    );

    app.get(
      '/reconciliations/:matchId',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'One result with its evidence and the candidates it discarded',
          params: z.object({ matchId: z.string() }),
          response: { 200: ReconciliationDto },
        },
      },
      async (request) => {
        const match = await flow.findReconciliation(request.params.matchId);
        if (!match) throw new NotFoundError(`Reconciliation ${request.params.matchId}`);
        return toReconciliationDto(match);
      },
    );

    app.get(
      '/unattributed-credits',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'Bank credits no batch claimed. Not errors, but the CFO must see them',
          querystring: z.object({ runId: z.string().optional() }),
          response: { 200: z.object({ credits: z.array(UnattributedCreditDto) }) },
        },
      },
      async (request) => {
        const report = await flow.flowReport(request.query.runId);
        return { credits: (report?.unattributed ?? []).map(toUnattributedCreditDto) };
      },
    );

    app.get(
      '/erp-reconciliations/:journalKey',
      {
        schema: {
          tags: ['erp'],
          summary: 'Ledger against its formal book, line by line, with the correction each implies',
          params: z.object({ journalKey: z.enum(['wompi', 'bancolombia']) }),
          querystring: z.object({ runId: z.string().optional(), status: z.string().optional() }),
          response: { 200: ErpReconciliationDto },
        },
      },
      async (request) => {
        const report = await erp.erpReconciliation({
          journalKey: request.params.journalKey,
          ...(request.query.runId ? { runId: request.query.runId } : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
        });
        if (!report) throw new NotFoundError(`ERP reconciliation for ${request.params.journalKey}`);
        return toErpReconciliationDto(report, accountMap);
      },
    );
  };
