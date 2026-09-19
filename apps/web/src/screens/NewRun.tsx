import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client.js';

/**
 * Running the process, end to end, from the screen.
 *
 * The brief asks for a tool an employee uses to reconcile, not just a viewer:
 * pick a period and the three phases run in order — ingest every source,
 * match channel to bank, then compare each ledger against its journal.
 */
export function NewRun() {
  const navigate = useNavigate();
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-04-30');
  const [state, setState] = useState<'idle' | 'running' | 'failed'>('idle');
  const [message, setMessage] = useState('');

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setState('running');
    setMessage('');

    try {
      const run = await api.startRun({ from, to });
      navigate(`/?run=${run.id}`);
    } catch (error) {
      setState('failed');
      setMessage(
        error instanceof ApiError ? error.message : 'La API no respondió. ¿Está levantada?',
      );
    }
  }

  return (
    <section>
      <header className="section__header">
        <h2>Nueva corrida</h2>
        <p>
          Ingesta Wompi y los extractos, concilia canal contra banco, y compara cada ledger
          contra su diario en Odoo.
        </p>
      </header>

      <form className="form" onSubmit={start}>
        <label htmlFor="run-from">
          Desde
          <input
            id="run-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          />
        </label>
        <label htmlFor="run-to">
          Hasta
          <input
            id="run-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="button" disabled={state === 'running'}>
          {state === 'running' ? 'Corriendo…' : 'Conciliar'}
        </button>
      </form>

      {state === 'running' && (
        <p className="muted">
          Leyendo las fuentes y conciliando. Con cuatro meses de datos toma unos segundos.
        </p>
      )}
      {state === 'failed' && <p className="error">{message}</p>}

      <div className="note-box">
        <h3>Extractos</h3>
        <p className="muted">
          Los PDFs de Bancolombia se leen de <code>data/fixtures/bancolombia</code>. Subirlos
          desde acá usa <code>POST /sources/&#123;id&#125;/documents</code>, que todavía no está
          conectado a esta pantalla.
        </p>
      </div>
    </section>
  );
}
