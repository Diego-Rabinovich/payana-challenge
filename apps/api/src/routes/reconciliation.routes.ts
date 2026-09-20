import {
  ErpReconciliationDto,
  MovementDto,
  OffsetPageDto,
  ReconciliationDto,
  ReconciliationSummaryDto,
  SettlementBatchDto,
  UnattributedCreditDto,
  WrittenEntryDto,
} from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError, RejectedError } from '../plugins/error-handler.js';
import {
  toErpReconciliationDto,
  toMovementDto,
  toReconciliationDto,
  toReconciliationSummaryDto,
  toSettlementBatchDto,
  toUnattributedCreditDto,
} from '@aa/adapters';
import type {
  AccountMap,
  CorrectionWrites,
  ErpQueries,
  FlowQueries,
  LedgerQueries,
  RuleSet,
} from '@aa/core';

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
    ledger: LedgerQueries,
    corrections: CorrectionWrites,
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
      '/reconciliations/:matchId/movements',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'The payments that make up a settlement and the credits that paid it',
          description:
            'What a settlement is, spelled out: the gateway charges due on one day, and the bank ' +
            'rows they arrived in. Enough to check the arithmetic by hand against a statement.',
          params: z.object({ matchId: z.string() }),
          response: {
            200: z.object({
              charges: z.array(MovementDto),
              credits: z.array(MovementDto),
              rejected: z.array(
                z.object({
                  movement: MovementDto,
                  score: z.number(),
                  rejectedBecause: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const match = await flow.findReconciliation(request.params.matchId);
        if (!match) throw new NotFoundError(`Reconciliation ${request.params.matchId}`);

        const [charges, credits] = await Promise.all([
          ledger.findMovements(match.left.chargeIds),
          ledger.findMovements(match.right?.movementIds ?? []),
        ]);

        // The candidates it set aside, as rows rather than as bare ids: a
        // reader deciding whether the matcher was right needs the date, the
        // amount and the descriptor, which an id does not carry.
        const rejected = await Promise.all(
          match.alternatives.map(async (alternative) => {
            const found = await ledger.findMovements(alternative.movementIds);
            return found.map((movement) => ({
              movement: toMovementDto(movement),
              score: alternative.score,
              rejectedBecause: alternative.rejectedBecause,
            }));
          }),
        );

        return {
          charges: charges.map(toMovementDto),
          credits: credits.map(toMovementDto),
          rejected: rejected.flat(),
        };
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

    app.post(
      '/erp-journal-entries',
      {
        schema: {
          tags: ['erp'],
          summary: 'Crea en Odoo, en borrador, la corrección que una línea implica',
          description:
            'El cuerpo lleva una referencia, nunca un asiento: el servidor reconstruye la ' +
            'corrección desde el reporte que él mismo produjo, así que un cliente no puede ' +
            'dictar cuentas ni montos. El alcance de la escritura sale del plan de cuentas en ' +
            'config/odoo-accounts.json — un diario que no esté ahí no se puede tocar.',
          body: z.object({
            journalKey: z.enum(['wompi', 'bancolombia']),
            ref: z.string().startsWith('mov:'),
            runId: z.string().optional(),
          }),
          response: { 201: z.object({ entryId: z.string(), ref: z.string() }) },
        },
      },
      async (request, reply) => {
        const { journalKey, ref, runId } = request.body;
        try {
          const entryId = await corrections.create({
            journalKey,
            ref,
            ...(runId ? { runId } : {}),
          });
          void reply.status(201);
          return { entryId, ref };
        } catch (cause) {
          throw new RejectedError(cause instanceof Error ? cause.message : 'Odoo rechazó el asiento');
        }
      },
    );

    app.get(
      '/erp-journal-entries',
      {
        schema: {
          tags: ['erp'],
          summary: 'Los asientos que este sistema dejó escritos en un diario',
          description:
            'Se le pregunta a Odoo, no a una anotación nuestra: si alguien contabilizó o borró ' +
            'el asiento, la respuesta cambia. La consola lo usa para marcar en la tabla lo que ' +
            'ya se creó, de manera que la marca sobreviva a recargar la página.',
          querystring: z.object({ journalKey: z.enum(['wompi', 'bancolombia']) }),
          response: { 200: z.object({ entries: z.array(WrittenEntryDto) }) },
        },
      },
      async (request) => {
        const entries = await corrections.written(request.query.journalKey);
        return {
          entries: entries.map((entry) => ({
            ref: entry.ref,
            entryId: entry.id,
            name: entry.name,
            state: entry.state,
            date: entry.date.toString(),
          })),
        };
      },
    );

    app.delete(
      '/erp-journal-entries/:ref',
      {
        schema: {
          tags: ['erp'],
          summary: 'Deshace un asiento que creó este sistema',
          description:
            'Sólo un borrador, sólo con nuestra referencia, sólo en nuestros diarios. Si un ' +
            'contador lo contabilizó o le cambió la referencia, ya no es nuestro y esto se niega.',
          params: z.object({ ref: z.string().startsWith('mov:') }),
          response: { 200: z.object({ removed: z.boolean() }) },
        },
      },
      async (request) => {
        try {
          return { removed: await corrections.remove(request.params.ref) };
        } catch (cause) {
          throw new RejectedError(cause instanceof Error ? cause.message : 'Odoo rechazó el borrado');
        }
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
