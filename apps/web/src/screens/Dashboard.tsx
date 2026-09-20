import type { ReconciliationSummaryDto } from '@aa/contracts';
import { Link } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { Failed, Loading } from '../components/States.js';
import { useRun } from '../components/Filters.js';
import { useResource } from '../lib/useResource.js';

/**
 * The one screen that has to be readable in five seconds.
 *
 * It answers the question in the title and nothing else: of the money the
 * gateway collected, how much reached the bank, and what is left over. The
 * detail lives one click away.
 */
export function Dashboard() {
  const run = useRun();
  const summary = useResource(() => api.summary(run), [run]);

  if (summary.state === 'loading') return <Loading />;
  if (summary.state === 'failed') return <Failed resource={summary} />;

  const data = summary.data;
  const counts = data.byStatus;

  return (
    <>
      <Funnel summary={data} />

      <div className="tiles">
        <Tile
          tone="confirmed"
          label="Conciliadas"
          value={counts['CONFIRMED'] ?? 0}
          note="Todo lo verificable coincide"
          to="/conciliacion?status=confirmed"
        />
        <Tile
          tone="probable"
          label="Probables"
          value={counts['PROBABLE'] ?? 0}
          note="Coinciden, con algún reparo"
          to="/conciliacion?status=probable"
        />
        <Tile
          tone="ambiguous"
          label="Ambiguas"
          value={counts['AMBIGUOUS'] ?? 0}
          note="Más de un crédito posible"
          to="/conciliacion?status=ambiguous"
        />
        <Tile
          tone="unmatched"
          label="Sin conciliar"
          value={counts['UNMATCHED'] ?? 0}
          note="Requieren mirar"
          to="/conciliacion?status=unmatched"
        />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="card__title">Créditos de Wompi que ningún lote reclamó</h2>
        <p className="card__hint">
          Plata que entró al banco desde Wompi y que no corresponde a ninguna liquidación de este
          período. Suele ser el pago de un lote anterior al rango, o dos lotes cobrados juntos.
        </p>
        <div className="tiles">
          <Tile
            tone="unmatched"
            label="Créditos de Wompi sin atribuir"
            value={data.unattributed.channel}
            note={show(data.unattributed.channelAmount)}
            to="/sin-atribuir"
          />
          <Tile
            tone="neutral"
            label="Otros ingresos al banco"
            value={data.unattributed.other}
            note="Intereses, otros pagadores. No son parte de esta conciliación"
            to="/sin-atribuir?channel=other"
          />
        </div>
      </div>

      <p className="faint">
        Ruleset <code>{data.rulesetVersion}</code>
        {data.runId && (
          <>
            {' · corrida '}
            <code>{data.runId}</code>
          </>
        )}
      </p>
    </>
  );
}

function Funnel({ summary }: { summary: ReconciliationSummaryDto }) {
  const scale = Math.max(1, summary.gross.cents);
  const width = (cents: number) => `${Math.min(100, Math.abs(cents) / scale * 100)}%`;
  const gap = summary.unexplained.cents;

  return (
    <div className="card">
      <h2 className="card__title">¿Dónde está la plata?</h2>
      <p className="card__hint">
        De lo que se vendió por Wompi, cuánto llegó a Bancolombia.
      </p>

      <div className="funnel">
        <Row label="Ventas brutas" width={width(summary.gross.cents)} value={show(summary.gross)} />
        <Row
          label={summary.deductionsAreDerived ? 'Deducciones (estimadas)' : 'Deducciones'}
          width={width(summary.deductions.cents)}
          value={`− ${show(summary.deductions)}`}
          variant="deduction"
        />
        <Row
          label="Neto esperado"
          width={width(summary.expectedNet.cents)}
          value={show(summary.expectedNet)}
        />
        <Row
          label="Acreditado en el banco"
          width={width(summary.observedNet.cents)}
          value={show(summary.observedNet)}
        />
        <div className="funnel__row funnel__row--total">
          <span className="funnel__label">Sin explicar</span>
          <div className="funnel__track">
            <div className="funnel__bar funnel__bar--gap" style={{ width: width(gap) }} />
          </div>
          <span className={`funnel__value ${gap > 0 ? 'neg' : ''}`}>{show(summary.unexplained)}</span>
        </div>
      </div>

      {summary.deductionsAreDerived && (
        <p className="banner banner--info" style={{ marginTop: 16, marginBottom: 0 }}>
          Wompi no informa sus comisiones por transacción. Las deducciones de arriba están
          <strong>&nbsp;derivadas</strong> de la diferencia entre lo vendido y lo acreditado,
          repartidas con las tasas de ley (IVA 19%, retefuente 1,5%). Por eso viajan siempre con el
          código <code>DEDUCTIONS_DERIVED</code> en la evidencia.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  width,
  value,
  variant,
}: {
  label: string;
  width: string;
  value: string;
  variant?: 'deduction';
}) {
  return (
    <div className="funnel__row">
      <span className="funnel__label">{label}</span>
      <div className="funnel__track">
        <div
          className={`funnel__bar ${variant === 'deduction' ? 'funnel__bar--deduction' : ''}`}
          style={{ width }}
        />
      </div>
      <span className="funnel__value">{value}</span>
    </div>
  );
}

function Tile({
  tone,
  label,
  value,
  note,
  to,
}: {
  tone: string;
  label: string;
  value: number;
  note: string;
  to: string;
}) {
  return (
    <Link className="tile" to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="tile__label">
        <span className={`dot dot--${tone}`} />
        {label}
      </div>
      <div className="tile__value">{value}</div>
      <div className="tile__note">{note}</div>
    </Link>
  );
}
