import type { AccountDto, MovementDto } from '@aa/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { Empty, Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

const TYPE_LABEL: Record<string, string> = {
  CHARGE: 'Venta',
  REFUND: 'Devolución',
  CHARGEBACK: 'Contracargo',
  FEE: 'Comisión',
  TAX: 'Impuesto',
  WITHHOLDING: 'Retención',
  INTEREST: 'Intereses',
  TRANSFER_IN: 'Ingreso',
  TRANSFER_OUT: 'Egreso',
  OTHER: 'Sin clasificar',
};

/**
 * The ledger itself — Phase 1's deliverable, made visible.
 *
 * A chronological run of one account's movements with a running balance, which
 * is what a ledger is. It matters that this screen exists before any
 * reconciliation screen: you cannot argue about whether two books agree until
 * you can show each of them.
 */
export function Ledger() {
  const accounts = useResource(() => api.accounts(), []);

  return (
    <Resolved resource={accounts} what="las cuentas">
      {({ accounts: list }) => <LedgerFor accounts={list} />}
    </Resolved>
  );
}

function LedgerFor({ accounts }: { accounts: readonly AccountDto[] }) {
  const [selected, setSelected] = useState(accounts[0]?.id ?? '');
  const movements = useResource(
    () => (selected ? api.movements(selected, { limit: 500 }) : Promise.resolve({ movements: [], page: { nextCursor: null, count: 0 } })),
    [selected],
  );

  return (
    <section>
      <header className="section__header">
        <h2>Ledger</h2>
        <p>Movimientos de una cuenta, en orden, con su saldo acumulado.</p>
        <div className="nav">
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              className={account.id === selected ? 'nav__link nav__link--active' : 'nav__link'}
              onClick={() => setSelected(account.id)}
            >
              {account.name}
            </button>
          ))}
        </div>
      </header>

      <Resolved resource={movements} what="los movimientos">
        {({ movements: rows }) =>
          rows.length === 0 ? (
            <Empty title="Sin movimientos">
              Esta cuenta no tiene movimientos ingestados para el período.
            </Empty>
          ) : (
            <MovementTable rows={rows} />
          )
        }
      </Resolved>
    </section>
  );
}

function MovementTable({ rows }: { rows: readonly MovementDto[] }) {
  // The running balance is composed here because it is a property of the view,
  // not of a movement: the same movement sits at a different balance depending
  // on where the reader started reading.
  let running = 0;

  return (
    <div className="scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Descripción</th>
            <th>Contraparte</th>
            <th className="right">Monto</th>
            <th className="right">Saldo</th>
            <th>Origen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((movement) => {
            running += movement.amount.cents;
            return (
              <tr key={movement.id}>
                <td>{movement.valueDate}</td>
                <td>
                  <span className="pill-type">{TYPE_LABEL[movement.type] ?? movement.type}</span>
                </td>
                <td>
                  {movement.externalId ? (
                    <Link to={`/movimientos/${movement.id}`}>{movement.description}</Link>
                  ) : (
                    movement.description
                  )}
                </td>
                <td>{movement.counterparty ?? '—'}</td>
                <td className="right">{show(movement.amount)}</td>
                <td className="right">{formatTotal(running)}</td>
                <td className="origin">{movement.source.locator ?? movement.source.sourceId}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatTotal(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$${whole},${digits.slice(-2)}`;
}
