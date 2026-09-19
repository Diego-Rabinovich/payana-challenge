import {
  ErpReconciliationDto,
  OffsetPageDto,
  ReconciliationDto,
  ReconciliationSummaryDto,
  SettlementBatchDto,
  UnattributedCreditDto,
} from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../plugins/error-handler.js';
import {
  toErpReconciliationDto,
  toReconciliationDto,
  toReconciliationSummaryDto,
  toSettlementBatchDto,
  toUnattributedCreditDto,
} from '@aa/adapters';
import type { AccountMap, ErpQueries, FlowQueries, RuleSet } from '@aa/core';

const StatusFilter = z
  .enum(['confirmed', 'probable', 'ambiguous', 'unmatched'])
  .optional()
  .describe('Filters the collection; omit for everything');

/**
 * Every collection here is paginated and every one takes a date range.
 *
 * Neither was true before, and the console paid for it: four months of results
 * arrived as one array, the browser rendered all of them, and there was no way
 * to ask about a week. A screen that cannot be narrowed is a screen nobody
 * reads.
 */
const Paging = {
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
};

const Range = {
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

function page<T>(items: readonly T[], { limit, offset }: { limit: number; offset: number }) {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

/** Inclusive on both ends; an absent bound means open on that side. */
function withinRange(date: string, from?: string, to?: string): boolean {
  return (from === undefined || date >= from) && (to === undefined || date <= to);
}

export const reconciliationRoutes =
  (
    flow: FlowQueries,
    erp: ErpQueries,
    accountMap: AccountMap,
    ruleSet: RuleSet,
  ): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/reconciliation-summary',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'The funnel and the counts. What the panel is built from',
          querystring: z.object({ runId: z.string().optional() }),
          response: { 200: ReconciliationSummaryDto },
        },
      },
      async (request) => {
        const report = await flow.flowReport(request.query.runId);
        if (!report) throw new NotFoundError('No run has been completed yet');

        return toReconciliationSummaryDto(report, ruleSet.version, (counterparty) =>
          ruleSet.isChannelCounterparty('wompi', counterparty),
        );
      },
    );

    app.get(
      '/settlement-batches',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'One row per settlement: what was sold, deducted and received',
          querystring: z.object({ runId: z.string().optional(), ...Range, ...Paging }),
          response: {
            200: z.object({ batches: z.array(SettlementBatchDto), page: OffsetPageDto }),
          },
        },
      },
      async (request) => {
        const { from, to, limit, offset } = request.query;
        const all = (await flow.listBatches(request.query.runId))
          .map(toSettlementBatchDto)
          .filter((batch) => withinRange(batch.batchDate, from, to));

        const { items, ...rest } = page(all, { limit, offset });
        return { batches: items, page: rest };
      },
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
          querystring: z.object({
            runId: z.string().optional(),
            status: StatusFilter,
            ...Range,
            ...Paging,
          }),
          response: {
            200: z.object({ reconciliations: z.array(ReconciliationDto), page: OffsetPageDto }),
          },
        },
      },
      async (request) => {
        const { from, to, limit, offset } = request.query;
        const all = (
          await flow.listReconciliations({
            ...(request.query.runId ? { runId: request.query.runId } : {}),
            ...(request.query.status ? { status: request.query.status } : {}),
          })
        )
          .map(toReconciliationDto)
          .filter((match) => withinRange(match.left.batchDate, from, to));

        const { items, ...rest } = page(all, { limit, offset });
        return { reconciliations: items, page: rest };
      },
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
          summary: 'Bank credits no settlement claimed',
          querystring: z.object({
            runId: z.string().optional(),
            // The bank account carries everything: interest, transfers from
            // other payers, account fees. Only the channel's own credits are a
            // reconciliation finding; the rest is noise the CFO may still want
            // to see, so it is filtered rather than dropped.
            channel: z
              .enum(['wompi', 'other', 'all'])
              .default('wompi')
              .describe('Whose credits to return. Defaults to the channel being reconciled'),
            ...Range,
            ...Paging,
          }),
          response: {
            200: z.object({ credits: z.array(UnattributedCreditDto), page: OffsetPageDto }),
          },
        },
      },
      async (request) => {
        const { from, to, limit, offset, channel } = request.query;
        const report = await flow.flowReport(request.query.runId);

        const all = (report?.unattributed ?? [])
          .map(toUnattributedCreditDto)
          .filter((credit) => withinRange(credit.valueDate, from, to))
          .filter((credit) => {
            if (channel === 'all') return true;
            const mine = ruleSet.isChannelCounterparty('wompi', credit.counterparty);
            return channel === 'wompi' ? mine : !mine;
          });

        const { items, ...rest } = page(all, { limit, offset });
        return { credits: items, page: rest };
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
