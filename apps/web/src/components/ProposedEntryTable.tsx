import type { ProposedEntryDto, WrittenEntryDto } from '@aa/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, show } from '../api/client.js';

/**
 * The correction a discrepancy implies, as a double-entry table.
 *
 * Showing it as an entry rather than as a sentence matters: an accountant can
 * check that debits equal credits at a glance, and that is the only way to
 * trust a proposal before anyone posts it.
 *
 * Writing it is reversible on purpose. The entry goes in as a **draft** and
 * the same panel offers to remove it, because the Odoo behind this is a
 * company's production accounting and an action nobody can undo has no place
 * behind a button. What the browser sends is the reference, never the entry:
 * the server rebuilds the correction from its own report, so nothing here can
 * dictate an account or an amount.
 *
 * Whether it was already written is not kept here: it arrives as `written`,
 * which the screen read off the ERP. A flag living in this component would
 * survive neither a reload nor somebody deleting the entry in Odoo, and a
 * mark that can be wrong about the books is worse than no mark.
 */
export function ProposedEntryTable({
  entry,
  journalKey,
  runId,
  written,
  onWrote,
}: {
  entry: ProposedEntryDto;
  journalKey: 'wompi' | 'bancolombia';
  runId?: string;
  written?: WrittenEntryDto;
  onWrote?: () => void;
}) {
  const debits = entry.lines.reduce((total, line) => total + line.debit.cents, 0);
  const credits = entry.lines.reduce((total, line) => total + line.credit.cents, 0);
  // Dos importes negativos que suman cero no son un asiento que cuadre, y el
  // servidor lo va a rechazar igual: mejor no ofrecer el botón.
  const negative = entry.lines.some((line) => line.debit.cents < 0 || line.credit.cents < 0);
  const balanced = !negative && debits === credits;

  const [trabajando, setTrabajando] = useState(false);
  const [recienCreado, setRecienCreado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crear = async () => {
    setTrabajando(true);
    setError(null);
    try {
      await api.createErpEntry({
        journalKey,
        ref: entry.ref,
        ...(runId ? { runId } : {}),
      });
      setRecienCreado(true);
      onWrote?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Odoo rechazó el asiento');
    } finally {
      setTrabajando(false);
    }
  };

  const deshacer = async () => {
    setTrabajando(true);
    setError(null);
    try {
      await api.deleteErpEntry(entry.ref);
      setRecienCreado(false);
      onWrote?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Odoo rechazó el borrado');
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>
        Asiento que corregiría esta diferencia
      </div>
      <header style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 8 }}>
        <code>{entry.ref}</code>
        <span className="muted">
          diario {entry.journalId} · {entry.date}
        </span>
      </header>

      {entry.missingConcepts.length > 0 && (
        <p className="muted">El asiento existente omite: {entry.missingConcepts.join(', ')}.</p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cuenta</th>
              <th>Concepto</th>
              <th className="num">Débito</th>
              <th className="num">Crédito</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line, index) => (
              <tr key={`${line.accountCode}-${index}`}>
                <td>
                  <code>{line.accountCode}</code> {line.accountName}
                </td>
                <td>{line.label}</td>
                <td className="num">{line.debit.cents > 0 ? show(line.debit) : ''}</td>
                <td className="num">{line.credit.cents > 0 ? show(line.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>
                <span className={balanced ? 'chip chip--confirmed' : 'chip chip--unmatched'}>
                  {balanced ? 'Cuadra' : 'No cuadra'}
                </span>
              </td>
              <td className="num">{formatTotal(debits)}</td>
              <td className="num">{formatTotal(credits)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div
        style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}
      >
        {written === undefined ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!balanced || trabajando}
            onClick={() => void crear()}
          >
            {trabajando ? 'Creando…' : 'Crear asiento en Odoo'}
          </button>
        ) : (
          <>
            <span className={`chip chip--${written.state === 'draft' ? 'ambiguous' : 'confirmed'}`}>
              {written.state === 'draft' ? 'Creado en borrador' : `Contabilizado · ${written.name}`}
            </span>
            <span className="faint">id {written.entryId}</span>
            {written.state === 'draft' && (
              <button
                type="button"
                className="btn"
                disabled={trabajando}
                onClick={() => void deshacer()}
              >
                {trabajando ? 'Borrando…' : 'Deshacer'}
              </button>
            )}
          </>
        )}
      </div>

      {/*
        Escribir en el ERP no rehace la conciliación: este reporte es lo que
        una corrida concluyó, no lo que Odoo tiene ahora. Decirlo acá evita la
        conclusión razonable y equivocada de que el botón no hizo nada.
      */}
      {written !== undefined && recienCreado && (
        <p className="banner banner--info" style={{ marginTop: 10 }}>
          Asiento creado en Odoo, en borrador. Esta pantalla sigue mostrando lo que concluyó la
          corrida anterior: para ver el efecto sobre la conciliación,{' '}
          <Link to="/corrida">hacé una corrida nueva</Link>.
        </p>
      )}

      {written !== undefined && written.state !== 'draft' && (
        <p className="banner banner--warn" style={{ marginTop: 10 }}>
          Ya está contabilizado, así que este sistema no lo borra: la vuelta atrás pasa a ser de
          Odoo, con «Restablecer a borrador» o un asiento de reversión.
        </p>
      )}

      {error && (
        <p className="banner banner--warn" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}

      <p className="faint" style={{ marginTop: 10 }}>
        Se crea en <strong>borrador</strong>, nunca contabilizado, y sólo en los diarios del plan
        de cuentas que nos dieron. Volver a apretarlo no duplica: la referencia{' '}
        <code>{entry.ref}</code> es la clave de idempotencia y se busca antes de escribir.
      </p>
    </div>
  );
}

/** Totals are composed here; every individual amount comes preformatted. */
function formatTotal(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$${whole},${digits.slice(-2)}`;
}
