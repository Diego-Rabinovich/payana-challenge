import type { ConfidenceDto, EvidenceDto } from '@aa/contracts';
import { phraseFor } from '../lib/evidence-phrases.js';

/**
 * The evidence behind a conclusion, and what each check was worth.
 *
 * This is the whole explainability story on screen, and it decides nothing:
 * it translates codes to sentences and shows the arithmetic. If the number and
 * the reasons ever disagree, the bug is in the engine, not here.
 *
 * Three marks, not two. A check that could not be run is neither a pass nor a
 * failure, and drawing it as a red cross was telling people something had
 * gone wrong when nothing had — the gateway simply never published the figure.
 */

const BAND_LABEL: Record<ConfidenceDto['band'], string> = {
  CONFIRMED: 'Conciliado',
  PROBABLE: 'Probable',
  AMBIGUOUS: 'Ambiguo',
  UNMATCHED: 'Sin conciliar',
};

const BAND_CLASS: Record<ConfidenceDto['band'], string> = {
  CONFIRMED: 'confirmed',
  PROBABLE: 'probable',
  AMBIGUOUS: 'ambiguous',
  UNMATCHED: 'unmatched',
};

export function StatusChip({ status }: { status: string }) {
  const tone = BAND_CLASS[status as ConfidenceDto['band']] ?? ERP_TONES[status] ?? 'neutral';
  return <span className={`chip chip--${tone}`}>{LABEL[status] ?? status}</span>;
}

/** The score as a number and a bar, so it reads at a glance and in detail. */
export function ConfidenceMeter({ confidence }: { confidence: ConfidenceDto }) {
  const tone = BAND_CLASS[confidence.band];
  return (
    <div>
      <div className="confidence">
        <span className="confidence__score">{confidence.score}</span>
        <span className="muted">/ 100</span>
      </div>
      <div className="meter" title={`${confidence.earned} de ${confidence.attainable} puntos`}>
        <div
          className={`meter__fill meter__fill--${tone}`}
          style={{ width: `${Math.max(2, confidence.score)}%` }}
        />
      </div>
      <div className="faint">
        {confidence.earned} de {confidence.attainable} puntos alcanzables
      </div>
    </div>
  );
}

export function EvidenceList({ confidence }: { confidence: ConfidenceDto }) {
  return (
    <>
      {confidence.disqualifiedBy && (
        <p className="banner banner--warn" style={{ marginTop: 0 }}>
          Descalificada por <code>{confidence.disqualifiedBy}</code>. Una verificación de este tipo
          no resta puntos: directamente impide dar el cruce por válido.
        </p>
      )}
      <ul className="evidence">
        {confidence.components.map((item, index) => (
          <EvidenceRow key={`${item.code}-${index}`} evidence={item} />
        ))}
      </ul>
    </>
  );
}

function EvidenceRow({ evidence }: { evidence: EvidenceDto }) {
  const notApplicable = evidence.applicable === false;
  const mark = notApplicable ? '–' : evidence.passed ? '✓' : '✗';
  const markTone = notApplicable ? 'na' : evidence.passed ? 'ok' : 'no';

  return (
    <li className="evidence__item">
      <span aria-hidden="true" className={`evidence__mark evidence__mark--${markTone}`}>
        {mark}
      </span>
      <div>
        <div className="evidence__text">{phraseFor(evidence)}</div>
        {(evidence.expected ?? evidence.observed) !== undefined && (
          <div className="evidence__meta">
            esperado {evidence.expected ?? '—'} · observado {evidence.observed ?? '—'}
          </div>
        )}
      </div>
      <div className="evidence__points">
        {notApplicable
          ? 'no aplica'
          : evidence.passed && evidence.weight
            ? `+${evidence.weight}`
            : evidence.passed
              ? '✓'
              : '0'}
        <code className="evidence__code">{evidence.code}</code>
      </div>
    </li>
  );
}

const LABEL: Readonly<Record<string, string>> = {
  CONFIRMED: 'Conciliado',
  PROBABLE: 'Probable',
  AMBIGUOUS: 'Ambiguo',
  UNMATCHED: 'Sin conciliar',
  UNRESOLVED_COMBINATORIAL: 'Sin resolver',
  MATCHED: 'Coincide',
  INCOMPLETE_ENTRY: 'Asiento incompleto',
  AMOUNT_MISMATCH: 'Monto distinto',
  DATE_SHIFT: 'Fecha corrida',
  MISSING_IN_ERP: 'Falta en el ERP',
  MISSING_IN_LEDGER: 'Falta en el ledger',
  DUPLICATE_IN_ERP: 'Duplicado en el ERP',
};

const ERP_TONES: Readonly<Record<string, string>> = {
  MATCHED: 'confirmed',
  DATE_SHIFT: 'ambiguous',
  INCOMPLETE_ENTRY: 'ambiguous',
  AMOUNT_MISMATCH: 'unmatched',
  MISSING_IN_ERP: 'unmatched',
  MISSING_IN_LEDGER: 'unmatched',
  DUPLICATE_IN_ERP: 'unmatched',
  UNRESOLVED_COMBINATORIAL: 'unmatched',
};
