import type { ProposedEntryDto } from '@aa/contracts';
import { show } from '../api/client.js';

/**
 * The correction a discrepancy implies, as a double-entry table.
 *
 * Showing it as an entry rather than as a sentence matters: an accountant can
 * check that debits equal credits at a glance, and that is the only way to
 * trust a proposal before anyone posts it.
 */
export function ProposedEntryTable({
  entry,
  writeEnabled,
}: {
  entry: ProposedEntryDto;
  writeEnabled: boolean;
}) {
  const debits = entry.lines.reduce((total, line) => total + line.debit.cents, 0);
  const credits = entry.lines.reduce((total, line) => total + line.credit.cents, 0);

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
        <p className="muted">
          El asiento existente omite: {entry.missingConcepts.join(', ')}.
        </p>
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
          <tr className={debits === credits ? 'balanced' : 'unbalanced'}>
            <td colSpan={2}>{debits === credits ? 'Cuadra' : 'No cuadra'}</td>
            <td className="num">{formatTotal(debits)}</td>
            <td className="num">{formatTotal(credits)}</td>
          </tr>
        </tfoot>
      </table>
      </div>

      <button type="button" className="btn" disabled={!writeEnabled} style={{ marginTop: 12 }}>
        Crear asiento en Odoo
      </button>
      {!writeEnabled && (
        <p className="faint">
          La escritura está deshabilitada (<code>ODOO_WRITE_ENABLED=false</code>). Este plan se
          puede revisar pero no se ejecuta.
        </p>
      )}
    </div>
  );
}

/** Totals are composed here; every individual amount comes preformatted. */
function formatTotal(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$${whole},${digits.slice(-2)}`;
}
