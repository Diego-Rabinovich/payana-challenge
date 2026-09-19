import { EVIDENCE_CODES as PUBLISHED } from '@aa/contracts';
import { EVIDENCE_CODES as DOMAIN } from '@aa/core';
import { describe, expect, it } from 'vitest';

/**
 * F04-T07. The vocabulary exists twice on purpose and must never differ.
 *
 * `core` owns it as a plain union because the domain takes no dependency on
 * zod; `contracts` publishes it as a zod enum because it is part of the wire.
 * This app is the only one that imports both, so this is the only place the
 * two can be compared — and comparing them here turns drift into a build
 * failure rather than a code the UI cannot render. See ADR-0010.
 */
describe('evidence vocabulary', () => {
  it('is identical in the domain and on the wire', () => {
    expect([...DOMAIN].sort()).toEqual([...PUBLISHED].sort());
  });

  it('is published in the order the domain declares, so docs and code agree', () => {
    expect([...PUBLISHED]).toEqual([...DOMAIN]);
  });

  it('is not empty, which would make the comparison vacuous', () => {
    expect(DOMAIN.length).toBeGreaterThan(20);
  });
});
