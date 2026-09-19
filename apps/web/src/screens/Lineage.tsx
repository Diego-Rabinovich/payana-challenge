import type { LineageDto } from '@aa/contracts';
import { useParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

const STAGE_LABEL: Record<LineageDto['steps'][number]['stage'], string> = {
  CHARGE: 'Pago aprobado',
  BATCH: 'Liquidación del día',
  SETTLEMENT: 'Neto a girar',
  BANK_CREDIT: 'Acreditado en el banco',
};

/**
 * Where one payment's money went.
 *
 * This is the brief's literal question — did the funds of this $100 payment,
 * net of fees, end up inside that credit? The bank never saw the $100 on its
 * own, so the answer needs the attributed share as well as the chain, and both
 * are shown with the ids that make the claim checkable.
 */
export function Lineage() {
  const { movementId = '' } = useParams();
  const resource = useResource(() => api.lineage(movementId), [movementId]);

  return (
    <Resolved resource={resource} what="el linaje del movimiento">
      {(lineage) => (
        <section>
          <header className="section__header">
            <h2>Linaje del pago</h2>
            <p>
              <code>{lineage.movementId}</code> · bruto {show(lineage.gross)} · neto atribuido{' '}
              <strong>{show(lineage.attributedNet)}</strong>
            </p>
          </header>

          <ol className="chain">
            {lineage.steps.map((step, index) => (
              <li key={`${step.stage}-${index}`} className="chain__step">
                <span className="chain__stage">{STAGE_LABEL[step.stage]}</span>
                <span className="chain__date">{step.date}</span>
                <span className="chain__amount">{show(step.amount)}</span>
                <span className="chain__detail">{step.detail}</span>
                <code className="chain__ref">{step.ref}</code>
              </li>
            ))}
          </ol>

          {!lineage.settled && (
            <p className="muted">
              Esta liquidación todavía no tiene una acreditación asignada, así que la cadena
              termina en el neto esperado.
            </p>
          )}

          <p className="muted">
            El neto atribuido es la parte proporcional de este pago sobre las deducciones del lote.
            Las partes de un lote suman exactamente el neto acreditado.
          </p>
        </section>
      )}
    </Resolved>
  );
}
