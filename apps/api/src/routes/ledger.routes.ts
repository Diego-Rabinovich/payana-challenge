import { AccountDto, CorrelationDto, LineageDto, MovementDto, MovementPageDto } from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../plugins/error-handler.js';
import { toAccountDto, toCorrelationDto, toLineageDto, toMovementDto } from '@aa/adapters';
import type { LedgerQueries } from '@aa/core';

/**
 * Ledger resources.
 *
 * Paths name things, never actions: a movement's provenance is
 * `/movements/{id}/lineage`, a sub-resource, not `/movements/{id}/trace`.
 * The verb is the HTTP method and nothing else.
 */
export const ledgerRoutes =
  (ledger: LedgerQueries): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/accounts',
      {
        schema: {
          tags: ['ledger'],
          summary: 'Accounts the system keeps a ledger for',
          response: { 200: z.object({ accounts: z.array(AccountDto) }) },
        },
      },
      async () => ({ accounts: (await ledger.listAccounts()).map(toAccountDto) }),
    );

    app.get(
      '/accounts/:accountId/movements',
      {
        schema: {
          tags: ['ledger'],
          summary: 'Movements of one account, newest page first',
          params: z.object({ accountId: z.string() }),
          querystring: z.object({
            from: z.string().optional(),
            to: z.string().optional(),
            cursor: z.string().optional(),
            offset: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(500).default(50),
          }),
          response: { 200: MovementPageDto },
        },
      },
      async (request) => {
        const { from, to, cursor, offset, limit } = request.query;
        const page = await ledger.listMovements({
          accountId: request.params.accountId,
          ...(from && to ? { window: { from, to } } : {}),
          ...(cursor ? { cursor } : {}),
          offset,
          limit,
        });

        return {
          movements: page.items.map(toMovementDto),
          page: {
            nextCursor: page.nextCursor,
            count: page.items.length,
            total: page.total,
            offset,
            limit,
          },
        };
      },
    );

    app.get(
      '/correlations',
      {
        schema: {
          tags: ['ledger'],
          summary: 'Are these two movements related, and why?',
          description:
            'The first primitive the brief suggests. Composes the batch, the match and the ' +
            'pro-rata share; makes no judgement of its own, so the explanation is the match’s ' +
            'own evidence and cannot disagree with what the reconciliation screen shows.',
          querystring: z.object({
            channelMovement: z.string(),
            bankMovement: z.string(),
          }),
          response: { 200: CorrelationDto },
        },
      },
      async (request) => {
        const { channelMovement, bankMovement } = request.query;
        const correlation = await ledger.correlationOf(channelMovement, bankMovement);
        if (!correlation) throw new NotFoundError(`Movimientos ${channelMovement} / ${bankMovement}`);
        return toCorrelationDto(correlation);
      },
    );

    app.get(
      '/movements/:movementId',
      {
        schema: {
          tags: ['ledger'],
          params: z.object({ movementId: z.string() }),
          response: { 200: MovementDto },
        },
      },
      async (request) => {
        const movement = await ledger.findMovement(request.params.movementId);
        if (!movement) throw new NotFoundError(`Movement ${request.params.movementId}`);
        return toMovementDto(movement);
      },
    );

    app.get(
      '/movements/:movementId/lineage',
      {
        schema: {
          tags: ['ledger'],
          summary: 'Where this payment’s money went, end to end',
          params: z.object({ movementId: z.string() }),
          response: { 200: LineageDto },
        },
      },
      async (request) => {
        const lineage = await ledger.lineageOf(request.params.movementId);
        if (!lineage) throw new NotFoundError(`Lineage for ${request.params.movementId}`);
        return toLineageDto(lineage);
      },
    );
  };
