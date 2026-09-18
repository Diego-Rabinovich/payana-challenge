import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { rawRecordId } from '../domain/ids.js';
import type { MovementRepository } from '../ports/repositories.js';
import { BANK_ACCOUNT, TEST_SOURCE, WOMPI_ACCOUNT, aMovement } from './builders.js';

/**
 * The MovementRepository contract, written once and run against every
 * implementation — in-memory and Postgres today, anything else tomorrow.
 *
 * This is what actually makes swapping an adapter safe. `implements` is a
 * compile-time shape check; this verifies the semantics no type system can
 * express: ordering, idempotency, and what an empty query does.
 */
export function movementRepositoryContract(
  name: string,
  makeRepository: () => Promise<MovementRepository> | MovementRepository,
): void {
  describe(`MovementRepository contract — ${name}`, () => {
    it('returns an empty array for an account with no movements, rather than throwing', async () => {
      const repository = await makeRepository();
      await expect(repository.findByAccount(WOMPI_ACCOUNT)).resolves.toEqual([]);
    });

    it('stores and retrieves a movement by id', async () => {
      const repository = await makeRepository();
      const movement = aMovement();

      await repository.upsertMany([movement]);

      await expect(repository.findById(movement.id)).resolves.toMatchObject({
        id: movement.id,
        type: movement.type,
      });
    });

    it('is idempotent: upserting the same movement twice stores it once', async () => {
      const repository = await makeRepository();
      const movement = aMovement();

      const first = await repository.upsertMany([movement]);
      const second = await repository.upsertMany([movement]);

      expect(first).toEqual({ inserted: 1, updated: 0 });
      expect(second).toEqual({ inserted: 0, updated: 1 });
      await expect(repository.countByAccount(movement.accountId)).resolves.toBe(1);
    });

    it('orders by value date, then by id, deterministically', async () => {
      const repository = await makeRepository();
      const later = aMovement({ valueDate: Temporal.PlainDate.from('2026-04-26'), ...locatorOf('b') });
      const earlier = aMovement({ valueDate: Temporal.PlainDate.from('2026-04-24'), ...locatorOf('a') });

      await repository.upsertMany([later, earlier]);
      const found = await repository.findByAccount(WOMPI_ACCOUNT);

      expect(found.map((m) => m.valueDate.toString())).toEqual(['2026-04-24', '2026-04-26']);
    });

    it('filters by date range, inclusive on both ends', async () => {
      const repository = await makeRepository();
      await repository.upsertMany([
        aMovement({ valueDate: Temporal.PlainDate.from('2026-04-23'), ...locatorOf('a') }),
        aMovement({ valueDate: Temporal.PlainDate.from('2026-04-24'), ...locatorOf('b') }),
        aMovement({ valueDate: Temporal.PlainDate.from('2026-04-25'), ...locatorOf('c') }),
      ]);

      const found = await repository.findByAccount(WOMPI_ACCOUNT, {
        from: Temporal.PlainDate.from('2026-04-24'),
        to: Temporal.PlainDate.from('2026-04-25'),
      });

      expect(found.map((m) => m.valueDate.toString())).toEqual(['2026-04-24', '2026-04-25']);
    });

    it('keeps accounts separate', async () => {
      const repository = await makeRepository();
      await repository.upsertMany([
        aMovement({ accountId: WOMPI_ACCOUNT, ...locatorOf('a') }),
        aMovement({ accountId: BANK_ACCOUNT, ...locatorOf('b') }),
      ]);

      await expect(repository.countByAccount(WOMPI_ACCOUNT)).resolves.toBe(1);
      await expect(repository.countByAccount(BANK_ACCOUNT)).resolves.toBe(1);
    });

    it('groups the parts of one sale by external id', async () => {
      const repository = await makeRepository();
      const externalId = 'tkfgjokoqfhwvigu71qqq';
      await repository.upsertMany([
        aMovement({ externalId, type: 'CHARGE', ...locatorOf('charge') }),
        aMovement({ externalId, type: 'FEE', ...locatorOf('fee') }),
        aMovement({ externalId, type: 'TAX', ...locatorOf('tax') }),
        aMovement({ externalId, type: 'WITHHOLDING', ...locatorOf('withholding') }),
      ]);

      const parts = await repository.findByExternalId(externalId);
      expect(parts.map((p) => p.type).sort()).toEqual(['CHARGE', 'FEE', 'TAX', 'WITHHOLDING']);
    });

    it('returns undefined for an unknown id, rather than throwing', async () => {
      const repository = await makeRepository();
      await expect(repository.findById(aMovement().id)).resolves.toBeUndefined();
    });
  });
}

/** Distinct locators keep the derived ids distinct where amounts repeat. */
function locatorOf(tag: string) {
  return {
    source: { sourceId: TEST_SOURCE, rawRecordId: rawRecordId('raw_test'), locator: tag },
  };
}
