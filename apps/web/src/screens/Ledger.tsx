import type { AccountDto, MovementDto } from '@aa/contracts';
import { Link, useSearchParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { PeriodFilter, Pager, useFilter } from '../components/Filters.js';
import { Empty, Failed, Loading, Resolved } from '../components/States.js';
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
 * A chronological run of one account's movements, which is what a ledger is.
 * It matters that this screen exists before any reconciliation screen: you
 * cannot argue about whether two books agree until you can show each of them.
 *
 * It used to fetch five hundred rows at once and render every one. On the
 * Wompi account that is most of a year of payments in a single scroll, with
 * no total, no period and no way to find anything.
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
  const [filter, update] = useFilter({ limit: 50 });
  const [params, setParams] = useSearchParams();
  const selected = params.get('cuenta') ?? accounts[0]?.id ?? '';

  const movements = useResource(
    () =>
      selected
        ? api.movements(selected, {
            ...(filter.from ? { from: filter.from } : {}),
            ...(filter.to ? { to: filter.to } : {}),
            limit: filter.limit,
            offset: filter.offset,
          })
        : Promise.resolve({
            movements: [],
            page: { nextCursor: null, count: 0, total: 0, offset: 0, limit: filter.limit },
          }),
    [selected, filter.from, filter.to, filter.limit, filter.offset],
  );

  const selectAccount = (id: string) => {
    const query = new URLSearchParams(params);
    query.set('cuenta', id);
    query.delete('offset');
    setParams(query, { replace: true });
  };

  const account = accounts.find((candidate) => candidate.id === selected);

  return (
    <div className="card">
      <h2 className="card__title">Ledger</h2>
      <p className="card__hint">
        Los movimientos de una cuenta, en orden, cada uno trazable hasta el documento del que
        salió.
      </p>

      <div className="segmented">
        {accounts.map((option) => (
          <button
            key={option.id}
            type="button"
            className={option.id === selected ? 'segmented__item segmented__item--on' : 'segmented__item'}
            onClick={() => selectAccount(option.id)}
          >
            {option.name}
          </button>
        ))}
      </div>

      <PeriodFilter filter={filter} onChange={update} />

      {movements.state === 'loading' && <Loading what="los movimientos" />}
      {movements.state === 'failed' && <Failed resource={movements} />}
      {movements.state === 'ready' && movements.data.movements.length === 0 && (
        <Empty title="Sin movimientos">
          {account
            ? `No hay movimientos de ${account.name} con estos filtros.`
            : 'Elegí una cuenta.'}
        </Empty>
      )}

      {movements.state === 'ready' && movements.data.movements.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Descripción</th>
                  <th>Contraparte</th>
                  <th className="num">Monto</th>
                  <th>Origen</th>
                </tr>
              </thead>
              <tbody>
                {movements.data.movements.map((movement) => (
                  <Row key={movement.id} movement={movement} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={movements.data.page} onChange={update} noun="movimientos" />
        </>
      )}
    </div>
  );
}

function Row({ movement }: { movement: MovementDto }) {
  const negative = movement.amount.cents < 0;

  return (
    <tr>
      <td>{movement.valueDate}</td>
      <td>
        <span className="chip chip--neutral">{TYPE_LABEL[movement.type] ?? movement.type}</span>
      </td>
      <td>
        {movement.type === 'CHARGE' ? (
          <Link to={`/movimientos/${movement.id}`}>{movement.description}</Link>
        ) : (
          movement.description
        )}
        {movement.externalId && <div className="faint mono">{movement.externalId}</div>}
      </td>
      <td className="muted">{movement.counterparty ?? '—'}</td>
      <td className={`num ${negative ? 'neg' : ''}`}>{show(movement.amount)}</td>
      <td className="faint">
        {/* Where this row came from, down to the locator inside the document. */}
        {movement.source.sourceId}
        <div className="mono">{movement.source.locator}</div>
      </td>
    </tr>
  );
}
