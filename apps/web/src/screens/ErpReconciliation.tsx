import type { ErpReconciliationLineDto } from '@aa/contracts';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { ProposedEntryTable } from '../components/ProposedEntryTable.js';
import { StatusChip } from '../components/StatusChip.js';
import { Empty, Resolved } from '../components/States.js';
import { phraseFor } from '../lib/evidence-phrases.js';
import { useResource } from '../lib/useResource.js';

const MATCH_LEVEL: Record<ErpReconciliationLineDto['matchLevel'], string> = {
  REF: 'por referencia',
  EXACT: 'por fecha y monto',
  AGGREGATED: 'agregado',
  APPROXIMATE: 'aproximado',
  NONE: 'sin match',
};

/**
 * The ledger against its formal book, line by line.
 *
 * Every row says which criterion resolved it, because "coinciden" is not an
 * answer: a match by reference is far stronger evidence than one by daily
 * aggregation, and a reader deciding whether to act needs to know which they
 * are looking at.
 */
export function ErpReconciliation() {
  const { journalKey = 'wompi' } = useParams<{ journalKey: 'wompi' | 'bancolombia' }>();
  const [onlyProblems, setOnlyProblems] = useState(true);

  const resource = useResource(
    () => api.erpReconciliation(journalKey as 'wompi' | 'bancolombia'),
    [journalKey],
  );

  return (
    <Resolved resource={resource} what="la conciliación contra el ERP">
      {(report) => {
        const lines = onlyProblems
          ? report.lines.filter((line) => line.status !== 'MATCHED')
          : report.lines;

        return (
          <section>
            <header className="section__header">
              <h2>ERP · {report.journalName}</h2>
              <p>
                {report.totals.ledgerGroups} grupos del ledger contra {report.totals.erpEntries}{' '}
                asientos · sin explicar {show(report.totals.unexplained)}
              </p>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={onlyProblems}
                  onChange={(event) => setOnlyProblems(event.target.checked)}
                />
                Solo discrepancias
              </label>
            </header>

            {lines.length === 0 ? (
              <Empty title="Todo coincide">
                Cada movimiento del ledger tiene su asiento y cada asiento su respaldo.
              </Empty>
            ) : (
              <ul className="queue">
                {lines.map((line, index) => (
                  <ErpLine key={`${line.erpEntryId ?? 'none'}-${index}`} line={line} />
                ))}
              </ul>
            )}
          </section>
        );
      }}
    </Resolved>
  );
}

function ErpLine({ line }: { line: ErpReconciliationLineDto }) {
  const [open, setOpen] = useState(false);
  const headline = line.evidence[0] ? phraseFor(line.evidence[0]) : '';

  return (
    <li className="queue__item">
      <button
        type="button"
        className="queue__summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <StatusChip status={line.status} />
        <span className="queue__date">{line.date}</span>
        <span className="queue__headline">{headline}</span>
        <span className="queue__amount">{show(line.delta ?? line.ledgerAmount)}</span>
      </button>

      {open && (
        <div className="queue__detail">
          <dl className="pairs">
            <div>
              <dt>Criterio</dt>
              <dd>{MATCH_LEVEL[line.matchLevel]}</dd>
            </div>
            <div>
              <dt>Ledger</dt>
              <dd>{show(line.ledgerAmount)}</dd>
            </div>
            <div>
              <dt>ERP</dt>
              <dd>
                {show(line.erpAmount)}
                {line.erpEntryName && <> · {line.erpEntryName}</>}
              </dd>
            </div>
            <div>
              <dt>Diferencia</dt>
              <dd>{show(line.delta)}</dd>
            </div>
          </dl>

          <ul className="evidence__list">
            {line.evidence.map((item, index) => (
              <li
                key={`${item.code}-${index}`}
                className={item.passed ? 'evidence__item' : 'evidence__item evidence__item--failed'}
              >
                <span aria-hidden="true" className="evidence__mark">
                  {item.passed ? '✓' : '✗'}
                </span>
                <p className="evidence__phrase">{phraseFor(item)}</p>
                <code className="evidence__code">{item.code}</code>
              </li>
            ))}
          </ul>

          {line.proposedEntry && (
            <ProposedEntryTable entry={line.proposedEntry} writeEnabled={false} />
          )}

          {line.ledgerMovementIds.length > 0 && (
            <p className="muted">
              Movimientos: {line.ledgerMovementIds.map((id) => <code key={id}>{id} </code>)}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

