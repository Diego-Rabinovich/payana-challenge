import type { LineageDto } from '@aa/contracts';
import { Link, useParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

const STAGE_LABEL: Record<LineageDto['steps'][number]['stage'], string> = {
  CHARGE: 'Pago aprobado',
  BATCH: 'Corte de liquidación',
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
      {(lineage) => {
        const kept = lineage.gross.cents - lineage.attributedNet.cents;

        return (
          <div className="card">
            <h2 className="card__title">Linaje del pago</h2>
            <p className="card__hint">
              <code>{lineage.movementId}</code>
            </p>

            <div className="tiles" style={{ marginBottom: 18 }}>
              <div className="tile">
                <div className="tile__label">Cobrado al cliente</div>
                <div className="tile__value" style={{ fontSize: 20 }}>
                  {show(lineage.gross)}
                </div>
              </div>
              <div className="tile">
                <div className="tile__label">Retenido por la pasarela</div>
                <div className="tile__value" style={{ fontSize: 20 }}>
                  {kept > 0 ? `− ${money(kept)}` : '—'}
                </div>
                <div className="tile__note">
                  {kept > 0
                    ? `${((kept / lineage.gross.cents) * 100).toFixed(2)}% del bruto`
                    : 'La liquidación todavía no tiene acreditación'}
                </div>
              </div>
              <div className="tile">
                <div className="tile__label">Llegó al banco</div>
                <div className="tile__value" style={{ fontSize: 20 }}>
                  {show(lineage.attributedNet)}
                </div>
                <div className="tile__note">Su parte proporcional del giro</div>
              </div>
            </div>

            <div className="steps">
              {lineage.steps.map((step, index) => (
                <div className="step" key={`${step.stage}-${index}`}>
                  <div>
                    <div className="step__name">{STAGE_LABEL[step.stage]}</div>
                    <code className="faint">{step.ref}</code>
                  </div>
                  <div className="muted">{step.date}</div>
                  <div className="num">{show(step.amount)}</div>
                  <div className="muted">{step.detail}</div>
                </div>
              ))}
            </div>

            {!lineage.settled && (
              <p className="banner banner--warn" style={{ marginTop: 16 }}>
                Este corte todavía no tiene una acreditación asignada, así que la cadena termina en
                el neto esperado y la parte retenida no se puede calcular.
              </p>
            )}

            <p className="faint" style={{ marginTop: 16 }}>
              El neto atribuido es la parte proporcional de este pago sobre el giro del lote. Las
              partes de un lote suman exactamente lo acreditado, sin perder ni inventar un centavo.{' '}
              {lineage.bankCreditId && (
                <>
                  Crédito: <Link to={`/movimientos/${lineage.bankCreditId}`}>
                    <code>{lineage.bankCreditId}</code>
                  </Link>
                </>
              )}
            </p>
          </div>
        );
      }}
    </Resolved>
  );
}

/** Only for a difference the UI computes; every stated amount arrives formatted. */
function money(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `$${whole},${digits.slice(-2)}`;
}
