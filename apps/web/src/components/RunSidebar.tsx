import type { RunDto } from '@aa/contracts';
import { NavLink, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useResource } from '../lib/useResource.js';

/**
 * Runs down the side, like a list of conversations.
 *
 * A run is the unit of everything here: the numbers on every screen belong to
 * one, and two runs over the same period can legitimately differ — a statement
 * arrived late, the ruleset changed, Wompi settled something. Tabs across the
 * top hid that, because they made the run an invisible global. Putting it in
 * the sidebar makes "which run am I looking at" the first thing you see and
 * the easiest thing to change.
 *
 * The selected run travels in the query string, so every screen is a link
 * someone can send.
 */

const VIEWS = [
  { to: '/', label: 'Panel', end: true },
  { to: '/conciliacion', label: 'Conciliación' },
  { to: '/sin-atribuir', label: 'Sin atribuir' },
  { to: '/erp/wompi', label: 'ERP · Wompi' },
  { to: '/erp/bancolombia', label: 'ERP · Bancolombia' },
  { to: '/ledger', label: 'Ledger' },
];

const REFERENCE = [
  { to: '/fuentes', label: 'Fuentes' },
  { to: '/glosario', label: 'Glosario' },
];

export function RunSidebar() {
  const runs = useResource(() => api.runs(25), []);
  const [params, setParams] = useSearchParams();
  const selected = params.get('run');

  const select = (runId: string | null) => {
    const next = new URLSearchParams(params);
    if (runId) next.set('run', runId);
    else next.delete('run');
    // A different run is a different question; page four of the old one is
    // not where anyone wants to land.
    next.delete('offset');
    setParams(next, { replace: false });
  };

  const keepRun = (to: string) => (selected ? `${to}${to.includes('?') ? '&' : '?'}run=${selected}` : to);

  return (
    <aside className="side">
      <NavLink to={keepRun('/corrida')} className="side__new">
        + Nueva corrida
      </NavLink>

      <div className="side__section">Vistas</div>
      <nav className="side__nav">
        {VIEWS.map((view) => (
          <NavLink
            key={view.to}
            to={keepRun(view.to)}
            end={view.end ?? false}
            className={({ isActive }) => (isActive ? 'side__link side__link--active' : 'side__link')}
          >
            {view.label}
          </NavLink>
        ))}
      </nav>

      <div className="side__section">Corridas</div>
      {runs.state === 'ready' && runs.data.runs.length === 0 && (
        <p className="side__empty">Todavía no corriste nada.</p>
      )}
      {runs.state === 'ready' && (
        <div className="side__runs">
          <button
            type="button"
            className={selected === null ? 'run run--active' : 'run'}
            onClick={() => select(null)}
          >
            <span className="run__title">Última corrida</span>
            <span className="run__meta">la más reciente, siempre</span>
          </button>
          {runs.data.runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              active={run.id === selected}
              onSelect={() => select(run.id)}
            />
          ))}
        </div>
      )}

      <div className="side__section">Referencia</div>
      <nav className="side__nav">
        {REFERENCE.map((view) => (
          <NavLink
            key={view.to}
            to={view.to}
            className={({ isActive }) => (isActive ? 'side__link side__link--active' : 'side__link')}
          >
            {view.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

function RunRow({
  run,
  active,
  onSelect,
}: {
  run: RunDto;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={active ? 'run run--active' : 'run'} onClick={onSelect}>
      <span className="run__title">
        {run.range.from} → {run.range.to}
      </span>
      <span className="run__meta">
        {when(run.startedAt)} · ruleset {run.rulesetVersion}
      </span>
    </button>
  );
}

/** A run from twenty minutes ago and one from March read very differently. */
function when(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);

  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 60 * 24) return `hace ${Math.round(minutes / 60)} h`;
  return then.toISOString().slice(0, 10);
}
