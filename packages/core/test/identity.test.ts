import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { deriveMovementId, deriveRawRecordId } from '../src/domain/identity.js';
import { sourceId } from '../src/domain/ids.js';
import { Money } from '../src/domain/money.js';
import { aCanonicalRecord } from '../src/testing/builders.js';

describe('deterministic ids (F01-T02)', () => {
  it('produces the same id for the same content, across runs', () => {
    expect(deriveMovementId(aCanonicalRecord())).toBe(deriveMovementId(aCanonicalRecord()));
  });


  it.each([
    ['amount', { amount: Money.ofCents(24_369_900) }],
    ['type', { type: 'FEE' as const }],
    ['value date', { valueDate: Temporal.PlainDate.from('2026-04-25') }],
    ['external id', { externalId: 'other-reference' }],
  ])('changes when the %s changes', (_field, override) => {
    expect(deriveMovementId(aCanonicalRecord(override))).not.toBe(
      deriveMovementId(aCanonicalRecord()),
    );
  });

  it('distinguishes two statement rows that are otherwise identical', () => {
    // A bank statement can legitimately hold the same amount, type and date
    // twice in one day. The locator is what keeps them apart.
    const first = aCanonicalRecord({
      source: { sourceId: sourceId('test:source'), rawRecordId: aCanonicalRecord().source.rawRecordId, locator: 'page=1;row=14' },
    });
    const second = aCanonicalRecord({
      source: { sourceId: sourceId('test:source'), rawRecordId: aCanonicalRecord().source.rawRecordId, locator: 'page=1;row=15' },
    });

    expect(deriveMovementId(first)).not.toBe(deriveMovementId(second));
  });

  it('derives a raw record id from source and content hash', () => {
    const id = deriveRawRecordId(sourceId('bancolombia:statement'), 'abc123');
    expect(id).toMatch(/^raw_[0-9a-f]{16}$/);
    expect(deriveRawRecordId(sourceId('bancolombia:statement'), 'abc123')).toBe(id);
    expect(deriveRawRecordId(sourceId('wompi:api'), 'abc123')).not.toBe(id);
  });
});
