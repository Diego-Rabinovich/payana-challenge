import type { MovementDto, ReconciliationDto } from '@aa/contracts';
import { Link } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { Collapsible } from './Collapsible.js';
import { Loading } from './States.js';
import { useResource } from '../lib/useResource.js';

/**
 * What a settlement actually is, spelled out.
 *
 * The expanded row used to list discarded candidates as bare movement ids,
 * which is unfollowable: to decide whether the matcher was right you need the
 * date, the amount and the descriptor of each credit it looked at, and the
 * payments that make up the batch in the first place. All of it is here so the
 * arithmetic can be checked by hand against a statement.
 */
export function SettlementDetail({ match }: { match: ReconciliationDto }) {
  // La corrida sale del resultado que estamos mostrando, no de la URL: el id
  // de un match es estable entre corridas, así que pedir sus movimientos sin
  // decir cuál devolvía los de la última aunque estuvieras viendo otra.
  const detail = useResource(
    () => api.settlementMovements(match.id, match.runId),
    [match.id, match.runId],
  );

  if (detail.state === 'loading') return <Loading what="los pagos" />;
  if (detail.state === 'failed') return <p className="faint">No se pudieron leer los pagos.</p>;

  const { charges, credits, rejected } = detail.data;
  const chargeTotal = charges.reduce((total, movement) => total + movement.amount.cents, 0);
  const creditTotal = credits.reduce((total, movement) => total + movement.amount.cents, 0);
  const kept = chargeTotal - creditTotal;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Collapsible
        title="Qué se liquidó"
        count={`${charges.length} ${charges.length === 1 ? 'pago' : 'pagos'} de Wompi`}
      >
        <MovementTable movements={charges} linkable />
        <Totals
          rows={[
            ['Bruto cobrado a los clientes', money(chargeTotal)],
            ['Retenido por Wompi', kept > 0 ? `− ${money(kept)}` : '—'],
            ['Acreditado en Bancolombia', money(creditTotal)],
          ]}
        />
      </Collapsible>

      <Collapsible
        title="Con qué se acreditó"
        count={
          credits.length === 1 ? 'una fila del extracto' : `${credits.length} filas del extracto`
        }
      >
        {credits.length === 0 ? (
          <p className="muted">Ningún crédito del banco quedó asignado a esta liquidación.</p>
        ) : (
          <MovementTable movements={credits} />
        )}
      </Collapsible>

      {rejected.length > 0 && (
        <Collapsible
          title="Créditos que se miraron y se descartaron"
          count={`${rejected.length}`}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Descripción del extracto</th>
                  <th>Contraparte</th>
                  <th className="num">Monto</th>
                  <th className="num">Puntaje</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((row) => (
                  <tr key={row.movement.id}>
                    <td>{row.movement.valueDate}</td>
                    <td>{row.movement.description}</td>
                    <td className="muted">{row.movement.counterparty ?? '—'}</td>
                    <td className="num">{show(row.movement.amount)}</td>
                    <td className="num muted">{row.score}</td>
                    <td>
                      <code>{row.rejectedBecause}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible>
      )}
    </div>
  );
}

function MovementTable({
  movements,
  linkable,
}: {
  movements: readonly MovementDto[];
  linkable?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha valor</th>
            <th>Referencia</th>
            <th>Descripción</th>
            <th className="num">Monto</th>
            <th>De dónde salió</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((movement) => (
            <tr key={movement.id}>
              <td>{movement.valueDate}</td>
              <td className="mono">
                {linkable ? (
                  <Link to={`/movimientos/${movement.id}`}>{movement.externalId ?? movement.id}</Link>
                ) : (
                  (movement.externalId ?? movement.id)
                )}
              </td>
              <td>{movement.description}</td>
              <td className="num">{show(movement.amount)}</td>
              <td className="faint">
                {movement.source.sourceId}
                <div className="mono">{movement.source.locator}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Totals({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <div className="funnel" style={{ marginTop: 12, maxWidth: 480 }}>
      {rows.map(([label, value], index) => (
        <div
          className={index === rows.length - 1 ? 'funnel__row funnel__row--total' : 'funnel__row'}
          key={label}
          style={{ gridTemplateColumns: '1fr 170px' }}
        >
          <span className="funnel__label">{label}</span>
          <span className="funnel__value">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Only for figures this component composes; stated amounts arrive formatted. */
function money(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$${whole},${digits.slice(-2)}`;
}
