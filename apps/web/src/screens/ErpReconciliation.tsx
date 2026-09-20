import type { ErpReconciliationLineDto, WrittenEntryDto } from '@aa/contracts';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { StatusChip } from '../components/Confidence.js';
import { PeriodFilter, Pager, useFilter, useRun } from '../components/Filters.js';
import { ProposedEntryTable } from '../components/ProposedEntryTable.js';
import { Empty, Resolved } from '../components/States.js';
import { phraseFor } from '../lib/evidence-phrases.js';
import { useResource } from '../lib/useResource.js';

/** Los tipos de discrepancia, en el orden en que alguien los atiende. */
const ESTADOS = [
  'AMOUNT_MISMATCH',
  'INCOMPLETE_ENTRY',
  'MISSING_IN_ERP',
  'MISSING_IN_LEDGER',
  'DATE_SHIFT',
  'DUPLICATE_IN_ERP',
];

const ESTADO_LABEL: Record<string, string> = {
  AMOUNT_MISMATCH: 'Monto distinto',
  INCOMPLETE_ENTRY: 'Asiento incompleto',
  MISSING_IN_ERP: 'Falta en el ERP',
  MISSING_IN_LEDGER: 'Falta en el ledger',
  DATE_SHIFT: 'Fecha corrida',
  DUPLICATE_IN_ERP: 'Duplicado en el ERP',
};

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
  const run = useRun();
  const [filter, update] = useFilter({ limit: 25 });
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const [escrito, setEscrito] = useState(0);

  // Lo que este sistema ya dejó escrito en ese diario, preguntado a Odoo.
  // Va aparte del reporte y tolera el error: si el ERP no contesta, la
  // pantalla pierde las marcas, no la conciliación entera.
  const [escritos, setEscritos] = useState<Map<string, WrittenEntryDto>>(new Map());
  useEffect(() => {
    let vigente = true;
    void api
      .erpWrittenEntries(journalKey as 'wompi' | 'bancolombia')
      .then((entries) => {
        if (vigente) setEscritos(new Map(entries.map((entry) => [entry.ref, entry])));
      })
      .catch(() => {
        if (vigente) setEscritos(new Map());
      });
    return () => {
      vigente = false;
    };
  }, [journalKey, escrito]);

  const resource = useResource(
    () =>
      api.erpReconciliation(journalKey as 'wompi' | 'bancolombia', run ? { runId: run } : {}),
    [journalKey, run, escrito],
  );

  return (
    <Resolved resource={resource} what="la conciliación contra el ERP">
      {(report) => {
        // El default es 'all', y el select lo refleja. Antes mostraba
        // "Solo discrepancias" mientras el filtro dejaba pasar todo, porque
        // sin valor ninguna de las dos condiciones recortaba nada.
        const mostrar = filter.status ?? 'all';
        // Quién mandó la plata. Con 415 líneas en el diario del banco,
        // poder quedarse sólo con Wompi es la diferencia entre revisarlo
        // y no abrirlo.
        const quien = params.get('quien') ?? 'todos';
        const contrapartes = [
          ...new Set(report.lines.map((line) => line.counterparty).filter(Boolean)),
        ].sort() as string[];

        const matching = report.lines
          .filter((line) => (mostrar === 'matched' ? line.status === 'MATCHED' : true))
          .filter((line) => (mostrar === 'problems' ? line.status !== 'MATCHED' : true))
          // Un tipo concreto de discrepancia: "falta en el ERP" y "monto
          // distinto" son colas de trabajo distintas, con gente distinta
          // resolviéndolas.
          .filter((line) => (ESTADOS.includes(mostrar) ? line.status === mostrar : true))
          .filter((line) => (quien === 'todos' ? true : line.counterparty === quien))
          .filter(
            (line) =>
              (filter.from === undefined || line.date >= filter.from) &&
              (filter.to === undefined || line.date <= filter.to),
          )
          // El reporte sale en el orden en que se resolvió cada grupo —
          // duplicados, después el ledger, después los asientos huérfanos —
          // que no es orden de nada para quien lee. Cronológico, y el nombre
          // del asiento como desempate para que la tabla no baile entre
          // corridas.
          .slice()
          .sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              (a.erpEntryName ?? '').localeCompare(b.erpEntryName ?? ''),
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
                <button
                  type="button"
                  className="tile"
                  key={status}
                  onClick={() => update({ status: mostrar === status ? 'all' : status })}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    outline: mostrar === status ? '2px solid var(--ink)' : 'none',
                  }}
                >
                  <div className="tile__label">
                    <StatusChip status={status} />
                  </div>
                  <div className="tile__value">{count}</div>
                </button>
              ))}
            </div>

            <PeriodFilter filter={filter} onChange={update}>
              {contrapartes.length > 1 && (
                <label className="field">
                  <span>Contraparte</span>
                  <select
                    value={quien}
                    onChange={(event) => {
                      const next = new URLSearchParams(params);
                      next.set('quien', event.target.value);
                      next.delete('offset');
                      setParams(next, { replace: true });
                    }}
                  >
                    <option value="todos">Todas</option>
                    {contrapartes.map((nombre) => (
                      <option key={nombre} value={nombre}>
                        {nombre}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span>Mostrar</span>
                <select value={mostrar} onChange={(event) => update({ status: event.target.value })}>
                  <option value="all">Todo ({report.lines.length})</option>
                  <option value="problems">Solo discrepancias</option>
                  <option value="matched">Solo lo que coincide</option>
                  {ESTADOS.filter((estado) => report.totals.byStatus[estado]).map((estado) => (
                    <option key={estado} value={estado}>
                      {ESTADO_LABEL[estado]} ({report.totals.byStatus[estado]})
                    </option>
                  ))}
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
                        <th>Descriptor</th>
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
                            journalKey={journalKey as 'wompi' | 'bancolombia'}
                            escritos={escritos}
                            {...(run ? { runId: run } : {})}
                            open={open === id}
                            onToggle={() => setOpen(open === id ? null : id)}
                            onWrote={() => setEscrito((n) => n + 1)}
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
  journalKey,
  escritos,
  runId,
  open,
  onToggle,
  onWrote,
}: {
  line: ErpReconciliationLineDto;
  journalKey: 'wompi' | 'bancolombia';
  escritos: Map<string, WrittenEntryDto>;
  runId?: string;
  open: boolean;
  onToggle: () => void;
  onWrote: () => void;
}) {
  const escrito = line.proposedEntry ? escritos.get(line.proposedEntry.ref) : undefined;

  return (
    <>
      <tr className={open ? 'expandable expanded' : 'expandable'} onClick={onToggle}>
        <td>{line.date}</td>
        <td>
          <StatusChip status={line.status} />
          {escrito && (
            <div>
              <span className="chip chip--ambiguous">asiento creado</span>
            </div>
          )}
        </td>
        <td>
          {line.descriptor ?? '—'}
          {line.counterparty && <div className="faint">{line.counterparty}</div>}
        </td>
        <td className="muted">{MATCH_LEVEL[line.matchLevel]}</td>
        <td className="mono">
          {line.erpEntryName ?? '—'}
          {line.erpEntryState === 'draft' && (
            <div>
              <span className="chip chip--ambiguous">borrador</span>
            </div>
          )}
        </td>
        <td className="num">{show(line.ledgerAmount)}</td>
        <td className="num">{show(line.erpAmount)}</td>
        <td className={`num ${(line.delta?.cents ?? 0) !== 0 ? 'neg' : ''}`}>{show(line.delta)}</td>
      </tr>

      {open && (
        <tr>
          <td className="detail-cell" colSpan={8}>
            <div style={{ display: 'grid', gap: 14 }}>
              {line.erpEntryState === 'draft' && (
                <p className="banner banner--warn" style={{ margin: 0 }}>
                  El asiento <code>{line.erpEntryName}</code> está en{' '}
                  <strong>borrador</strong>: coincide con el ledger, pero todavía no está
                  contabilizado, así que no suma en ningún balance y puede cambiar o borrarse.
                  Para que cuente, alguien tiene que contabilizarlo en Odoo.
                </p>
              )}

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
                <ProposedEntryTable
                  entry={line.proposedEntry}
                  journalKey={journalKey}
                  {...(escrito ? { written: escrito } : {})}
                  {...(runId ? { runId } : {})}
                  onWrote={onWrote}
                />
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
