import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { api } from './api/client.js';
import { RunSidebar } from './components/RunSidebar.js';
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
 * A panel with a sidebar, not a row of tabs.
 *
 * Tabs made the run an invisible global: every screen showed the latest one
 * and there was no way to look at a previous one, or even to notice that the
 * numbers belonged to a particular run at all. The run is the unit of
 * everything here, so it goes where it can be seen and switched.
 */
export function App() {
  const health = useResource(() => api.health());
  const [params] = useSearchParams();
  const run = params.get('run');

  return (
    <div className="shell">
      <RunSidebar />

      <div className="shell__main">
        <header className="topbar">
          <div>
            <h1>¿Dónde está la plata?</h1>
            <p>Alimentos Alcázar · Wompi → Bancolombia → Odoo</p>
          </div>
          {run && (
            <span className="topbar__run" title="Estás viendo una corrida anterior">
              corrida <code>{run}</code>
            </span>
          )}
        </header>

        {health.state === 'ready' && <SourceBanner health={health.data} />}

        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/conciliacion" element={<Reconciliation />} />
            <Route path="/sin-atribuir" element={<Unattributed />} />
            <Route path="/corrida" element={<NewRun />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/fuentes" element={<Sources />} />
            <Route path="/glosario" element={<Glossary />} />
            <Route path="/movimientos/:movementId" element={<Lineage />} />
            <Route path="/erp/:journalKey" element={<ErpReconciliation />} />
            {/* Old links keep working rather than dead-ending on the panel. */}
            <Route path="/liquidaciones" element={<Navigate to="/conciliacion" replace />} />
            <Route path="/excepciones" element={<Navigate to="/conciliacion" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
