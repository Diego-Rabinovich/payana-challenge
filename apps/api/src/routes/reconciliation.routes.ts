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
  RunQueries,
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

/**
 * El alcance, en el path y obligatorio.
 *
 * `latest` es un valor válido y se resuelve del lado del servidor, así que el
 * panel sigue teniendo una URL estable sin que «la última» quede implícita en
 * ningún lado.
 */
const RunParam = { runId: z.string().describe('Id de la corrida, o `latest`') };

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
    runs: RunQueries,
    accountMap: AccountMap,
    ruleSet: RuleSet,
  ): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    /**
     * Resuelve el alcance antes de leer nada.
     *
     * Una corrida que no existe es un 404, no los números de otra. Y `latest`
     * se convierte acá en un id concreto, así que de este punto para adentro
     * nadie vuelve a razonar sobre «la más reciente» — la respuesta puede
     * decir de qué corrida habla porque lo sabe.
     */
    const scope = async (runId: string): Promise<string> => {
      const resolved = await runs.resolve(runId);
      if (!resolved) throw new NotFoundError(`Run ${runId}`);
      return resolved;
    };

    app.get(
      '/runs/:runId/summary',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'The funnel and the counts. What the panel is built from',
          params: z.object(RunParam),
          response: { 200: ReconciliationSummaryDto },
        },
      },
      async (request) => {
        const report = await flow.flowReport(await scope(request.params.runId));
        if (!report) throw new NotFoundError(`Run ${request.params.runId} has no phase-2 report`);

        return toReconciliationSummaryDto(report, ruleSet.version, (counterparty) =>
          ruleSet.isChannelCounterparty('wompi', counterparty),
        );
      },
    );

    app.get(
      '/runs/:runId/settlement-batches',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'One row per settlement: what was sold, deducted and received',
          params: z.object(RunParam),
          querystring: z.object({ ...Range, ...Paging }),
          response: {
            200: z.object({ batches: z.array(SettlementBatchDto), page: OffsetPageDto }),
          },
        },
      },
      async (request) => {
        const { from, to, limit, offset } = request.query;
        const all = (await flow.listBatches(await scope(request.params.runId)))
          .map(toSettlementBatchDto)
          .filter((batch) => withinRange(batch.batchDate, from, to));

        const { items, ...rest } = page(all, { limit, offset });
        return { batches: items, page: rest };
      },
    );

    app.get(
      '/runs/:runId/settlement-batches/:batchId',
      {
        schema: {
          tags: ['reconciliation'],
          params: z.object({ ...RunParam, batchId: z.string() }),
          response: { 200: SettlementBatchDto },
        },
      },
      async (request) => {
        const runId = await scope(request.params.runId);
        const batch = await flow.findBatch(runId, request.params.batchId);
        if (!batch) throw new NotFoundError(`Batch ${request.params.batchId}`);
        return toSettlementBatchDto(batch);
      },
    );

    app.get(
      '/runs/:runId/reconciliations',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'Channel-to-bank results; filter by status for the exception queue',
          params: z.object(RunParam),
          querystring: z.object({ status: StatusFilter, ...Range, ...Paging }),
          response: {
            200: z.object({ reconciliations: z.array(ReconciliationDto), page: OffsetPageDto }),
          },
        },
      },
      async (request) => {
        const { from, to, limit, offset } = request.query;
        const all = (
          await flow.listReconciliations({
            runId: await scope(request.params.runId),
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
      '/runs/:runId/reconciliations/:matchId',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'One result with its evidence and the candidates it discarded',
          description:
            'El id de un match es estable entre corridas a propósito, así que nombra un ' +
            'emparejamiento y no un resultado: el mismo id puede tener otro score bajo otra ' +
            'corrida. Por eso el alcance va en el path y no admite default.',
          params: z.object({ ...RunParam, matchId: z.string() }),
          response: { 200: ReconciliationDto },
        },
      },
      async (request) => {
        const runId = await scope(request.params.runId);
        const match = await flow.findReconciliation(runId, request.params.matchId);
        if (!match) throw new NotFoundError(`Reconciliation ${request.params.matchId}`);
        return toReconciliationDto(match);
      },
    );

    app.get(
      '/runs/:runId/reconciliations/:matchId/movements',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'The payments that make up a settlement and the credits that paid it',
          description:
            'What a settlement is, spelled out: the gateway charges due on one day, and the bank ' +
            'rows they arrived in. Enough to check the arithmetic by hand against a statement.',
          params: z.object({ ...RunParam, matchId: z.string() }),
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
        const runId = await scope(request.params.runId);
        const match = await flow.findReconciliation(runId, request.params.matchId);
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
      '/runs/:runId/unattributed-credits',
      {
        schema: {
          tags: ['reconciliation'],
          summary: 'Bank credits no settlement claimed',
          params: z.object(RunParam),
          querystring: z.object({
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
        const report = await flow.flowReport(await scope(request.params.runId));

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
            // La corrección se reconstruye del reporte de una corrida, así que
            // cuál es una entrada de la operación, no un filtro opcional.
            runId: z.string(),
          }),
          response: { 201: z.object({ entryId: z.string(), ref: z.string() }) },
        },
      },
      async (request, reply) => {
        const { journalKey, ref } = request.body;
        // El alcance se resuelve afuera del try: una corrida que no existe es
        // un 404, no un rechazo de Odoo. Adentro, el catch convertía las dos
        // cosas en el mismo 400.
        const runId = await scope(request.body.runId);

        try {
          const entryId = await corrections.create({ journalKey, ref, runId });
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
      '/runs/:runId/erp-reconciliations/:journalKey',
      {
        schema: {
          tags: ['erp'],
          summary: 'Ledger against its formal book, line by line, with the correction each implies',
          params: z.object({ ...RunParam, journalKey: z.enum(['wompi', 'bancolombia']) }),
          querystring: z.object({ status: z.string().optional() }),
          response: { 200: ErpReconciliationDto },
        },
      },
      async (request) => {
        const report = await erp.erpReconciliation({
          journalKey: request.params.journalKey,
          runId: await scope(request.params.runId),
          ...(request.query.status ? { status: request.query.status } : {}),
        });
        if (!report) throw new NotFoundError(`ERP reconciliation for ${request.params.journalKey}`);
        return toErpReconciliationDto(report, accountMap);
      },
    );
  };
