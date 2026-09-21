import type { StatementFileDto } from '@aa/contracts';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

/**
 * The three phases, in the order the brief states them, as something you do.
 *
 * Before this screen the pipeline began with files already sitting in a
 * directory nobody could see, so the console showed the result of a step the
 * user had never taken. Uploading a statement is now the first phase, visibly.
 */
export function NewRun() {
  const navigate = useNavigate();
  const [statementsKey, setStatementsKey] = useState(0);
  const statements = useResource(() => api.statements(), [statementsKey]);

  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-04-30');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const created = await api.startRun({ from, to });
      setLastRunId(created.id);
      navigate('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo correr la conciliación.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2 className="card__title">Fase 1 · Ingesta</h2>
        <p className="card__hint">
          Wompi y Odoo se leen por API. El extracto de Bancolombia es un PDF que alguien tiene que
          traer: subilo acá y la próxima corrida lo lee.
        </p>

        <StatementUpload onUploaded={() => setStatementsKey((key) => key + 1)} />

        <div className="section-title">Extractos cargados</div>
        <Resolved resource={statements} what="los extractos">
          {(data) =>
            data.statements.length === 0 ? (
              <p className="muted">Todavía no hay ninguno. Sin extracto no hay fase 2.</p>
            ) : (
              <StatementTable files={data.statements} />
            )
          }
        </Resolved>
      </div>

      <div className="card">
        <h2 className="card__title">Fases 2 y 3 · Conciliar</h2>
        <p className="card__hint">
          Elegí el período.
        </p>

        <div className="filters">
          <label className="field">
            <span>Desde</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span>Hasta</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button className="btn btn--primary" onClick={() => void run()} disabled={running}>
            {running ? 'Corriendo…' : 'Correr conciliación'}
          </button>
        </div>

        {running && (
          <p className="banner banner--info">
            Leyendo Wompi y Odoo en vivo y parseando los extractos. Sobre cuatro meses tarda cerca
            de un minuto.
          </p>
        )}
        {error && <p className="banner banner--warn">{error}</p>}

        <div className="phases">
          <Phase n={1} title="Ingesta" done>
            Cada fuente se vuelve movimientos con signo, trazables hasta el byte del que salieron.
          </Phase>
          <Phase n={2} title="Wompi → Bancolombia" done>
            Un resultado por liquidación, con su evidencia y los candidatos descartados.
          </Phase>
          <Phase n={3} title="Ledger → Odoo" done>
            Línea por línea contra los diarios 48 y 49, con el asiento que corregiría cada
            diferencia. Solo lectura.
          </Phase>
        </div>
      </div>

      <DownloadReport runId={lastRunId} />
    </>
  );
}

function StatementUpload({ onUploaded }: { onUploaded: () => void }) {
  const [over, setOver] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const send = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setFailed(false);

      for (const file of Array.from(files)) {
        setStatus(`Subiendo ${file.name}…`);
        try {
          const base64 = await toBase64(file);
          await api.uploadStatement(file.name, base64);
          setStatus(`${file.name} cargado.`);
        } catch (cause) {
          setFailed(true);
          setStatus(cause instanceof Error ? cause.message : `No se pudo subir ${file.name}.`);
          return;
        }
      }
      onUploaded();
    },
    [onUploaded],
  );

  return (
    <>
      <div
        className={over ? 'upload upload--over' : 'upload'}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void send(event.dataTransfer.files);
        }}
      >
        <p style={{ margin: '0 0 10px' }}>Arrastrá acá los extractos en PDF</p>
        <label className="btn">
          Elegir archivos
          <input
            type="file"
            accept="application/pdf"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => void send(event.target.files)}
          />
        </label>
      </div>
      {status && (
        <p className={failed ? 'banner banner--warn' : 'banner banner--info'} style={{ marginTop: 12 }}>
          {status}
        </p>
      )}
    </>
  );
}

function StatementTable({ files }: { files: readonly StatementFileDto[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Archivo</th>
            <th className="num">Tamaño</th>
            <th>Recibido</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.name}>
              <td>{file.name}</td>
              <td className="num">{Math.round(file.bytes / 1024).toLocaleString('es-AR')} KB</td>
              <td className="muted">{file.receivedAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DownloadReport({ runId }: { runId: string | null }) {
  const runs = useResource(() => api.runs(1));
  const [busy, setBusy] = useState(false);

  const download = async (id: string) => {
    setBusy(true);
    try {
      const markdown = await api.reportMarkdown(id);
      // A blob rather than a link to the endpoint: the file lands with a name
      // a person recognises instead of "report".
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `conciliacion-${id}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card__title">Reporte</h2>
      <p className="card__hint">
        El mismo artefacto que escribe <code>make demo</code>: Markdown para una persona.
      </p>
      <Resolved resource={runs} what="las corridas">
        {(data) => {
          const id = runId ?? data.runs[0]?.id;
          if (!id) return <p className="muted">Todavía no hay ninguna corrida.</p>;
          return (
            <button className="btn" disabled={busy} onClick={() => void download(id)}>
              {busy ? 'Generando…' : `Descargar reporte de ${id}`}
            </button>
          );
        }}
      </Resolved>
    </div>
  );
}

function Phase({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="phase">
      <div className={done ? 'phase__number phase__number--done' : 'phase__number'}>{n}</div>
      <div>
        <div className="phase__title">{title}</div>
        <div className="phase__body">{children}</div>
      </div>
    </div>
  );
}

/** The browser already has the bytes; base64 is what the endpoint accepts. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
