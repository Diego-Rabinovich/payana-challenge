import type { ConfidenceDto, EvidenceDto } from '@aa/contracts';
import { phraseFor } from '../lib/evidence-phrases.js';

/**
 * The evidence behind a conclusion.
 *
 * This component is the whole explainability story on screen, and it does not
 * compute or decide anything: it translates codes to sentences and shows what
 * each check contributed. If the number and the reasons ever disagree, the
 * bug is in the engine, not here.
 */
export function EvidenceList({ confidence }: { confidence: ConfidenceDto }) {
  return (
    <div className="evidence">
      <div className="evidence__score">
        <strong>{confidence.score}</strong>
        <span className="evidence__band">{BAND_LABEL[confidence.band]}</span>
        <span className="evidence__raw">
          {confidence.earned} de {confidence.attainable} puntos posibles
        </span>
      </div>

      <ul className="evidence__list">
        {confidence.components.map((item, index) => (
          <EvidenceRow key={`${item.code}-${index}`} evidence={item} />
        ))}
      </ul>
    </div>
  );
}

function EvidenceRow({ evidence }: { evidence: EvidenceDto }) {
  return (
    <li className={evidence.passed ? 'evidence__item' : 'evidence__item evidence__item--failed'}>
      <span aria-hidden="true" className="evidence__mark">
        {evidence.passed ? '✓' : '✗'}
      </span>
      <div>
        <p className="evidence__phrase">{phraseFor(evidence)}</p>
        {(evidence.expected ?? evidence.observed) && (
          <p className="evidence__values">
            <span>esperado: {evidence.expected ?? '—'}</span>
            <span>observado: {evidence.observed ?? '—'}</span>
          </p>
        )}
      </div>
      {evidence.weight !== undefined && evidence.passed && (
        <span className="evidence__weight">+{evidence.weight}</span>
      )}
      <code className="evidence__code">{evidence.code}</code>
    </li>
  );
}

const BAND_LABEL: Record<ConfidenceDto['band'], string> = {
  CONFIRMED: 'Confirmado',
  PROBABLE: 'Probable',
  AMBIGUOUS: 'Ambiguo',
  UNMATCHED: 'Sin conciliar',
};
