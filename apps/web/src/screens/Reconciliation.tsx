import type { ReconciliationDto } from '@aa/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { ConfidenceMeter, EvidenceList, StatusChip } from '../components/Confidence.js';
import { PeriodFilter, StatusFilter, Pager, useFilter, useRun } from '../components/Filters.js';
import { Collapsible } from '../components/Collapsible.js';
import { SettlementDetail } from '../components/SettlementDetail.js';
import { Empty, Failed, Loading } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

/** Only for a figure the table composes; stated amounts arrive formatted. */
function money(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$${whole},${digits.slice(-2)}`;
}

/**
 * Every settlement, in one table.
 *
 * This used to be two screens — "liquidaciones" listing all of them and
 * "excepciones" listing the bad ones — which meant the same row looked
 * different depending on which door you came through, and neither screen
 * could be narrowed to a week. One table, one row shape, a status filter and
 * a date range.
 *
 * A row expands in place rather than navigating: the question people actually
 * ask is "why this one", and answering it should not lose their place in the
 * list.
 */
export function Reconciliation() {
  const run = useRun();
  const [filter, update] = useFilter({ limit: 25 });
  const [open, setOpen] = useState<string | null>(null);

  const page = useResource(
    () =>
      api.reconciliations({
        ...(run ? { runId: run } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
        limit: filter.limit,
        offset: filter.offset,
      }),
    [run, filter.status, filter.from, filter.to, filter.limit, filter.offset],
  );

  return (
    <div className="card">
      <h2 className="card__title">Conciliación Wompi → Bancolombia</h2>
      <p className="card__hint">
        Una fila por liquidación: lo que se vendió, lo que se dedujo, lo que llegó y cuánto le
        creemos. Tocá una fila para ver por qué.
      </p>

      <PeriodFilter filter={filter} onChange={update}>
        <StatusFilter value={filter.status} onChange={(status) => update({ status })} />
      </PeriodFilter>

      {page.state === 'loading' && <Loading />}
      {page.state === 'failed' && <Failed resource={page} />}
      {page.state === 'ready' && page.data.rows.length === 0 && (
        <Empty>No hay liquidaciones con esos filtros.</Empty>
      )}

      {page.state === 'ready' && page.data.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Corte</th>
                  <th className="num">Pagos</th>
                  <th className="num">Bruto</th>
                  <th className="num">Deducción</th>
                  <th className="num">Acreditado</th>
                  <th className="num">Sin explicar</th>
                  <th className="num">Confianza</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {page.data.rows.map((match) => (
                  <Row
                    key={match.id}
                    match={match}
                    open={open === match.id}
                    onToggle={() => setOpen(open === match.id ? null : match.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page.data.page} onChange={update} noun="liquidaciones" />
        </>
      )}
    </div>
  );
}

function Row({
  match,
  open,
  onToggle,
}: {
  match: ReconciliationDto;
  open: boolean;
  onToggle: () => void;
}) {
  const deducted = match.derivedDeductions;
  const settled = match.right?.movementIds ?? [];

  // What the credit does not account for once the derived commission is taken
  // out. Showing the raw delta against the gross printed the whole commission
  // as if it were missing money, on every single row.
  const unexplained =
    match.amounts.observedNet === undefined
      ? match.amounts.gross.cents
      : match.amounts.gross.cents - (deducted?.total.cents ?? 0) - match.amounts.observedNet.cents;

  return (
    <>
      <tr className={open ? 'expandable expanded' : 'expandable'} onClick={onToggle}>
        <td>{match.left.batchDate}</td>
        <td className="num">{match.left.chargeIds.length}</td>
        <td className="num">{show(match.amounts.gross)}</td>
        <td className="num muted">
          {deducted ? `− ${show(deducted.total)}` : '—'}
          {deducted && (
            <div className="faint">{(deducted.impliedRate * 100).toFixed(2)}%</div>
          )}
        </td>
        <td className="num">{show(match.amounts.observedNet)}</td>
        <td className={`num ${unexplained !== 0 ? 'neg' : ''}`}>
          {unexplained === 0 ? '—' : money(unexplained)}
        </td>
        <td className="num">{match.confidence.score}</td>
        <td>
          <StatusChip status={match.status} />
        </td>
      </tr>

      {open && (
        <tr>
          <td className="detail-cell" colSpan={8}>
            <div style={{ display: 'grid', gap: 16 }}>
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                <ConfidenceMeter confidence={match.confidence} />
                <div className="faint" style={{ maxWidth: 420 }}>
                  Regla <code>{match.rule.id}</code> v{match.rule.version} · ruleset{' '}
                  <code>{match.rulesetVersion}</code>
                  <br />
                  Ventana esperada {match.window.from} a {match.window.to} (días hábiles)
                  <br />
                  {settled.length > 0 ? (
                    <>
                      Acreditado por{' '}
                      {settled.map((id, index) => (
                        <span key={id}>
                          {index > 0 && ' + '}
                          <Link to={`/movimientos/${id}`}>
                            <code>{id}</code>
                          </Link>
                        </span>
                      ))}
                    </>
                  ) : (
                    'Ningún crédito quedó asignado a este lote.'
                  )}
                </div>
              </div>

              <Collapsible
                title="Evidencia"
                count={`${match.confidence.components.length} controles · ${match.confidence.earned} de ${match.confidence.attainable} puntos`}
              >
                <EvidenceList confidence={match.confidence} />
              </Collapsible>

              <SettlementDetail match={match} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
