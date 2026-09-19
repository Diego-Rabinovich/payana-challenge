import { AccountDto, LineageDto, MovementDto, MovementPageDto } from '@aa/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../plugins/error-handler.js';
import { toAccountDto, toLineageDto, toMovementDto } from '@aa/adapters';
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
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
          response: { 200: MovementPageDto },
        },
      },
      async (request) => {
        const { from, to, cursor, limit } = request.query;
        const page = await ledger.listMovements({
          accountId: request.params.accountId,
          ...(from && to ? { window: { from, to } } : {}),
          ...(cursor ? { cursor } : {}),
          limit,
        });

        return {
          movements: page.items.map(toMovementDto),
          page: { nextCursor: page.nextCursor, count: page.items.length },
        };
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
