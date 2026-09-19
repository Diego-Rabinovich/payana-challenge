import type { ErpReconciliationLineDto } from '@aa/contracts';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { StatusChip } from '../components/Confidence.js';
import { PeriodFilter, Pager, useFilter } from '../components/Filters.js';
import { ProposedEntryTable } from '../components/ProposedEntryTable.js';
import { Empty, Resolved } from '../components/States.js';
import { phraseFor } from '../lib/evidence-phrases.js';
import { useResource } from '../lib/useResource.js';

const MATCH_LEVEL: Record<ErpReconciliationLineDto['matchLevel'], string> = {
  REF: 'por referencia',
  EXACT: 'por fecha y monto',
  AGGREGATED: 'agregado',
  APPROXIMATE: 'aproximado',
  NONE: 'sin correspondencia',
};

/**
 * The ledger against its formal book, line by line.
 *
 * Every row says which criterion resolved it, because "coinciden" is not an
 * answer: a match by reference is far stronger evidence than one by daily
 * aggregation, and a reader deciding whether to act needs to know which they
 * are looking at.
 *
 * Paginated in the browser rather than at the API: a journal comparison is one
 * coherent artifact — the totals are of the whole thing — so it is fetched
 * whole and windowed here.
 */
export function ErpReconciliation() {
  const { journalKey = 'wompi' } = useParams<{ journalKey: 'wompi' | 'bancolombia' }>();
  const [filter, update] = useFilter({ limit: 25 });
  const [open, setOpen] = useState<string | null>(null);

  const resource = useResource(
    () => api.erpReconciliation(journalKey as 'wompi' | 'bancolombia'),
    [journalKey],
  );

  return (
    <Resolved resource={resource} what="la conciliación contra el ERP">
      {(report) => {
        const matching = report.lines
          .filter((line) => (filter.status === 'matched' ? line.status === 'MATCHED' : true))
          .filter((line) =>
            filter.status === 'problems' ? line.status !== 'MATCHED' : true,
          )
          .filter(
            (line) =>
              (filter.from === undefined || line.date >= filter.from) &&
              (filter.to === undefined || line.date <= filter.to),
          );

        const rows = matching.slice(filter.offset, filter.offset + filter.limit);

        return (
          <div className="card">
            <h2 className="card__title">ERP · {report.journalName}</h2>
            <p className="card__hint">
              {report.totals.ledgerGroups} grupos del ledger contra {report.totals.erpEntries}{' '}
              asientos del diario {report.journalId}. Sin explicar{' '}
              <strong>{show(report.totals.unexplained)}</strong>. Esta pantalla es de solo lectura:
              nada se escribe en Odoo.
            </p>

            <div className="tiles" style={{ marginBottom: 16 }}>
              {Object.entries(report.totals.byStatus).map(([status, count]) => (
                <div className="tile" key={status}>
                  <div className="tile__label">
                    <StatusChip status={status} />
                  </div>
                  <div className="tile__value">{count}</div>
                </div>
              ))}
            </div>

            <PeriodFilter filter={filter} onChange={update}>
              <label className="field">
                <span>Mostrar</span>
                <select
                  value={filter.status ?? 'problems'}
                  onChange={(event) => update({ status: event.target.value })}
                >
                  <option value="problems">Solo discrepancias</option>
                  <option value="matched">Solo lo que coincide</option>
                  <option value="all">Todo</option>
                </select>
              </label>
            </PeriodFilter>

            {rows.length === 0 ? (
              <Empty>No hay líneas con esos filtros.</Empty>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Estado</th>
                        <th>Criterio</th>
                        <th>Asiento</th>
                        <th className="num">Ledger</th>
                        <th className="num">ERP</th>
                        <th className="num">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((line, index) => {
                        const id = `${line.date}-${line.erpEntryId ?? index}`;
                        return (
                          <Row
                            key={id}
                            line={line}
                            open={open === id}
                            onToggle={() => setOpen(open === id ? null : id)}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager
                  page={{ total: matching.length, offset: filter.offset, limit: filter.limit }}
                  onChange={update}
                  noun="líneas"
                />
              </>
            )}
          </div>
        );
      }}
    </Resolved>
  );
}

function Row({
  line,
  open,
  onToggle,
}: {
  line: ErpReconciliationLineDto;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={open ? 'expandable expanded' : 'expandable'} onClick={onToggle}>
        <td>{line.date}</td>
        <td>
          <StatusChip status={line.status} />
        </td>
        <td className="muted">{MATCH_LEVEL[line.matchLevel]}</td>
        <td className="mono">{line.erpEntryName ?? '—'}</td>
        <td className="num">{show(line.ledgerAmount)}</td>
        <td className="num">{show(line.erpAmount)}</td>
        <td className={`num ${(line.delta?.cents ?? 0) !== 0 ? 'neg' : ''}`}>{show(line.delta)}</td>
      </tr>

      {open && (
        <tr>
          <td className="detail-cell" colSpan={7}>
            <div style={{ display: 'grid', gap: 14 }}>
              <ul className="evidence">
                {line.evidence.map((item, index) => (
                  <li className="evidence__item" key={`${item.code}-${index}`}>
                    <span
                      aria-hidden="true"
                      className={`evidence__mark evidence__mark--${item.passed ? 'ok' : 'no'}`}
                    >
                      {item.passed ? '✓' : '✗'}
                    </span>
                    <div className="evidence__text">{phraseFor(item)}</div>
                    <div className="evidence__points">
                      <code className="evidence__code">{item.code}</code>
                    </div>
                  </li>
                ))}
              </ul>

              {line.proposedEntry && (
                <ProposedEntryTable entry={line.proposedEntry} writeEnabled={false} />
              )}

              {line.ledgerMovementIds.length > 0 && (
                <div className="faint">
                  Movimientos: {line.ledgerMovementIds.map((id) => id).join(', ')}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
