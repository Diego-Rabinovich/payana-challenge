import { EVIDENCE_CODES, type EvidenceDto } from '@aa/contracts';
import { describe, expect, it } from 'vitest';
import { hasPhrase, phraseFor } from './evidence-phrases.js';

/**
 * F05-T01. The vocabulary comes from `@aa/contracts`, the frontend's only
 * backend dependency — the same list the API serves at `GET /evidence-codes`.
 *
 * Coverage is really guaranteed by the type system: `PHRASES` is typed
 * `Record<EvidenceCode, …>`, so a new code fails to compile until it has a
 * sentence. This test states the intent and catches the case where someone
 * widens that type to make an error go away.
 */
const evidence = (code: string, extra: Partial<EvidenceDto> = {}): EvidenceDto =>
  ({ code, dimension: 'AMOUNT', passed: false, ...extra }) as EvidenceDto;

describe('evidence phrases', () => {
  it('has a Spanish sentence for every published code', () => {
    const missing = EVIDENCE_CODES.filter((code) => !hasPhrase(code));
    expect(missing).toEqual([]);
  });

  it('renders every code as a real sentence, not an identifier', () => {
    for (const code of EVIDENCE_CODES) {
      const phrase = phraseFor(evidence(code));
      expect(phrase.length).toBeGreaterThan(10);
      expect(phrase).not.toContain(code);
    }
  });

  it('still says something for a payload that lies about its own schema', () => {
    expect(phraseFor(evidence('MADE_UP_CODE')).length).toBeGreaterThan(0);
  });

  it('names the concepts an incomplete entry omits, in Spanish', () => {
    const phrase = phraseFor(
      evidence('INCOMPLETE_ENTRY', { dimension: 'ERP', detail: 'faltan: FEE, TAX, WITHHOLDING' }),
    );

    expect(phrase).toContain('la comisión');
    expect(phrase).toContain('el IVA de la comisión');
    expect(phrase).toContain('la retención en la fuente');
  });

  it('reads naturally when only one concept is missing', () => {
    const phrase = phraseFor(evidence('INCOMPLETE_ENTRY', { dimension: 'ERP', detail: 'faltan: FEE' }));

    expect(phrase).toBe('El asiento registra la venta pero no incluye la comisión.');
  });

  it('says plainly that an ambiguous match has a rival', () => {
    const phrase = phraseFor(
      evidence('COMPETING_CANDIDATE', { dimension: 'UNIQUENESS', detail: 'runner-up scored 92' }),
    );

    expect(phrase).toContain('otro depósito igualmente compatible');
  });

  it('says that derived deductions were derived, rather than implying they were reported', () => {
    const phrase = phraseFor(evidence('DEDUCTIONS_DERIVED', { detail: '4,31% del bruto' }));

    expect(phrase).toContain('se derivaron');
    expect(phrase).toContain('4,31%');
  });
});
