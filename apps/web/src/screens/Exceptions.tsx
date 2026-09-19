import type { ReconciliationDto } from '@aa/contracts';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { EvidenceList } from '../components/EvidenceList.js';
import { StatusChip } from '../components/StatusChip.js';
import { Empty, Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

/**
 * The work queue.
 *
 * Nobody wants a table of three thousand rows; they want the seven things that
 * are wrong. So the default is what did not close, ranked by the amount at
 * risk rather than by date — what matters is how much money an exception
 * represents, not when it happened.
 */
export function Exceptions() {
  const [params] = useSearchParams();
  const filter = params.get('estado');
  const resource = useResource(() => api.reconciliations(), []);

  return (
    <Resolved resource={resource} what="las conciliaciones">
      {({ reconciliations }) => (
        <Queue items={reconciliations} filter={filter} />
      )}
    </Resolved>
  );
}

function Queue({ items, filter }: { items: readonly ReconciliationDto[]; filter: string | null }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const selected = items
    .filter((item) => (filter ? matchesFilter(item, filter) : item.status !== 'CONFIRMED'))
    .sort((a, b) => amountAtRisk(b) - amountAtRisk(a));

  if (selected.length === 0) {
    return (
      <Empty title={filter ? 'Nada en este estado' : 'Todo cerró'}>
        {filter
          ? 'Ninguna liquidación del período quedó en este estado.'
          : `Las ${items.length} liquidaciones del período conciliaron contra el banco. No hay nada pendiente de revisión.`}
      </Empty>
    );
  }

  return (
    <section>
      <header className="section__header">
        <h2>{filter ? `Liquidaciones · ${filter}` : 'Excepciones'}</h2>
        <p>
          {selected.length} de {items.length} liquidaciones, ordenadas por monto en riesgo.
          {filter && (
            <>
              {' '}
              <Link to="/excepciones">ver todas las excepciones</Link>
            </>
          )}
        </p>
      </header>

      <ul className="queue">
        {selected.map((item) => (
          <li key={item.id} className="queue__item">
            <button
              type="button"
              className="queue__summary"
              aria-expanded={expanded === item.id}
              onClick={() => setExpanded(expanded === item.id ? null : item.id)}
            >
              <StatusChip status={item.status} />
              <span className="queue__date">{item.left.batchDate}</span>
              <span className="queue__headline">{headline(item)}</span>
              <span className="queue__amount">{show(item.amounts.expectedNet)}</span>
            </button>

            {expanded === item.id && (
              <div className="queue__detail">
                <EvidenceList confidence={item.confidence} />

                {item.alternatives.length > 0 && (
                  <div className="alternatives">
                    <h4>Alternativas descartadas</h4>
                    <ul>
                      {item.alternatives.map((alternative) => (
                        <li key={alternative.movementIds.join('+')}>
                          <code>{alternative.movementIds.join(' + ')}</code> —{' '}
                          {alternative.score} puntos, descartada por{' '}
                          <code>{alternative.rejectedBecause}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="queue__provenance">
                  Regla <code>{item.rule.id}</code> v{item.rule.version} · ruleset{' '}
                  <code>{item.rulesetVersion}</code> · ventana {item.window.from} a{' '}
                  {item.window.to}
                  {item.left.chargeIds[0] && (
                    <>
                      {' · '}
                      <Link to={`/movimientos/${item.left.chargeIds[0]}`}>ver linaje</Link>
                    </>
                  )}
                </p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function matchesFilter(item: ReconciliationDto, filter: string): boolean {
  if (filter === 'unmatched') {
    return item.status === 'UNMATCHED' || item.status === 'UNRESOLVED_COMBINATORIAL';
  }
  return item.status === filter.toUpperCase();
}

/** One sentence, built from the result rather than from prose in the backend. */
function headline(item: ReconciliationDto): string {
  const day = item.left.batchDate;
  const payments = item.left.chargeIds.length;

  switch (item.status) {
    case 'UNMATCHED':
      return `Las ventas del ${day} (${payments} pagos) no tienen acreditación en el banco.`;
    case 'AMBIGUOUS':
      return `Las ventas del ${day} tienen más de un depósito compatible.`;
    case 'UNRESOLVED_COMBINATORIAL':
      return `No se pudo determinar qué pagos del ${day} componen el depósito.`;
    case 'CONFIRMED':
      return `Las ventas del ${day} (${payments} pagos) se acreditaron sin diferencias.`;
    default:
      return `Las ventas del ${day} se acreditaron con una diferencia de ${show(item.amounts.delta)}.`;
  }
}

function amountAtRisk(item: ReconciliationDto): number {
  return Math.abs(item.amounts.delta?.cents ?? item.amounts.expectedNet.cents);
}
