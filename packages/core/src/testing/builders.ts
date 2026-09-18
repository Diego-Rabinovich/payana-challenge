import { Temporal } from '@js-temporal/polyfill';
import { deriveMovementId } from '../domain/identity.js';
import { accountId, rawRecordId, sourceId } from '../domain/ids.js';
import { Money } from '../domain/money.js';
import type { CanonicalRecord, Movement, MovementType, RawRecord } from '../domain/movement.js';
import { sha256 } from '../domain/identity.js';

/** Builders so tests state only what they are actually about. */

export const TEST_SOURCE = sourceId('test:source');
export const WOMPI_ACCOUNT = accountId('wompi:AA');
export const BANK_ACCOUNT = accountId('bancolombia:00000000000');

export function aCanonicalRecord(overrides: Partial<CanonicalRecord> = {}): CanonicalRecord {
  const base: CanonicalRecord = {
    accountId: WOMPI_ACCOUNT,
    externalId: 'tkfgjokoqfhwvigu71qqq',
    occurredAt: Temporal.Instant.from('2026-04-24T23:44:00Z'),
    valueDate: Temporal.PlainDate.from('2026-04-24'),
    type: 'CHARGE' as MovementType,
    amount: Money.ofCents(24_369_800),
    description: 'Pago aprobado',
    source: {
      sourceId: TEST_SOURCE,
      rawRecordId: rawRecordId('raw_test'),
      locator: 'tx=1',
    },
    metadata: {},
  };
  return { ...base, ...overrides };
}

export function aMovement(overrides: Partial<CanonicalRecord> = {}): Movement {
  const record = aCanonicalRecord(overrides);
  return { ...record, id: deriveMovementId(record) };
}

export function aRawRecord(overrides: Partial<RawRecord> = {}): RawRecord {
  const payload = overrides.payload ?? 'raw payload';
  const base: RawRecord = {
    id: rawRecordId('raw_test'),
    sourceId: TEST_SOURCE,
    origin: 'file:test',
    fetchedAt: Temporal.Instant.from('2026-09-17T12:00:00Z'),
    contentHash: sha256(typeof payload === 'string' ? payload : Buffer.from(payload)),
    payload,
  };
  return { ...base, ...overrides };
}
