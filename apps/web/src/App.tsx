import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api/client.js';
import { SourceBanner } from './components/States.js';
import { useResource } from './lib/useResource.js';
import { Dashboard } from './screens/Dashboard.js';
import { ErpReconciliation } from './screens/ErpReconciliation.js';
import { Exceptions } from './screens/Exceptions.js';
import { Ledger } from './screens/Ledger.js';
import { Lineage } from './screens/Lineage.js';
import { NewRun } from './screens/NewRun.js';
import { Settlements } from './screens/Settlements.js';

const SECTIONS = [
  { to: '/', label: 'Panel', end: true },
  { to: '/corrida', label: 'Nueva corrida' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/excepciones', label: 'Excepciones' },
  { to: '/liquidaciones', label: 'Liquidaciones' },
  { to: '/erp/wompi', label: 'ERP · Wompi' },
  { to: '/erp/bancolombia', label: 'ERP · Bancolombia' },
];

/**
 * The shell: navigation, the source banner, and the routes.
 *
 * Routes exist rather than tabs because an exception is a thing you send to
 * someone — "mirá esta" has to survive being pasted into a chat.
 */
export function App() {
  const health = useResource(() => api.health());

  return (
    <div className="app">
      <header className="app__header">
        <h1>¿Dónde está la plata?</h1>
        <p>Alimentos Alcázar · conciliación Wompi → Bancolombia → Odoo</p>
        <nav className="nav">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              end={section.end ?? false}
              className={({ isActive }) => (isActive ? 'nav__link nav__link--active' : 'nav__link')}
            >
              {section.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {health.state === 'ready' && <SourceBanner health={health.data} />}

      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/corrida" element={<NewRun />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/excepciones" element={<Exceptions />} />
          <Route path="/liquidaciones" element={<Settlements />} />
          <Route path="/movimientos/:movementId" element={<Lineage />} />
          <Route path="/erp/:journalKey" element={<ErpReconciliation />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
