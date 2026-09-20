import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api/client.js';
import { SourceBanner } from './components/States.js';
import { useResource } from './lib/useResource.js';
import { Dashboard } from './screens/Dashboard.js';
import { ErpReconciliation } from './screens/ErpReconciliation.js';
import { Glossary } from './screens/Glossary.js';
import { Ledger } from './screens/Ledger.js';
import { Lineage } from './screens/Lineage.js';
import { NewRun } from './screens/NewRun.js';
import { Reconciliation } from './screens/Reconciliation.js';
import { Sources } from './screens/Sources.js';
import { Unattributed } from './screens/Unattributed.js';

/**
 * Five destinations, not seven.
 *
 * "Liquidaciones" and "Excepciones" were the same table twice, which made the
 * navigation a list of implementation details rather than of questions. What
 * is left maps to what someone actually wants: the answer, the detail behind
 * it, what did not fit, what the ERP says, and the raw ledger.
 */
const SECTIONS = [
  { to: '/', label: 'Panel', end: true },
  { to: '/conciliacion', label: 'Conciliación' },
  { to: '/sin-atribuir', label: 'Sin atribuir' },
  { to: '/erp/wompi', label: 'ERP · Wompi' },
  { to: '/erp/bancolombia', label: 'ERP · Bancolombia' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/fuentes', label: 'Fuentes' },
  { to: '/corrida', label: 'Nueva corrida' },
  { to: '/glosario', label: 'Glosario' },
];

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
          <Route path="/conciliacion" element={<Reconciliation />} />
          <Route path="/sin-atribuir" element={<Unattributed />} />
          <Route path="/corrida" element={<NewRun />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/glosario" element={<Glossary />} />
          <Route path="/fuentes" element={<Sources />} />
          <Route path="/movimientos/:movementId" element={<Lineage />} />
          <Route path="/erp/:journalKey" element={<ErpReconciliation />} />
          {/* Old links keep working rather than dead-ending on the panel. */}
          <Route path="/liquidaciones" element={<Navigate to="/conciliacion" replace />} />
          <Route path="/excepciones" element={<Navigate to="/conciliacion" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
