import { useSearchParams } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { PeriodFilter, Pager, useFilter, useRun } from '../components/Filters.js';
import { Empty, Failed, Loading } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

/**
 * Credits nobody claimed.
 *
 * Split by who sent them, because the two halves are different questions. A
 * Wompi credit with no settlement behind it is a finding: the money arrived
 * and we cannot say what it paid for. Interest from the bank is not — it is
 * simply not part of this reconciliation, and mixing the two buried thirteen
 * real findings under a hundred and fifty irrelevant rows.
 */
export function Unattributed() {
  const run = useRun();
  const [filter, update] = useFilter({ limit: 25 });
  const [params, setParams] = useSearchParams();
  const channel = (params.get('channel') ?? 'wompi') as 'wompi' | 'other' | 'all';

  const page = useResource(
    () =>
      api.unattributedCredits({
        channel,
        ...(run ? { runId: run } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
        limit: filter.limit,
        offset: filter.offset,
      }),
    [run, channel, filter.from, filter.to, filter.limit, filter.offset],
  );

  const setChannel = (next: string) => {
    const query = new URLSearchParams(params);
    query.set('channel', next);
    query.delete('offset');
    setParams(query, { replace: true });
  };

  return (
    <div className="card">
      <h2 className="card__title">Ingresos que ningún lote reclamó</h2>
      <PeriodFilter filter={filter} onChange={update}>
        <label className="field">
          <span>Origen</span>
          <select value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="wompi">Wompi</option>
            <option value="other">Otros</option>
            <option value="all">Todos</option>
          </select>
        </label>
      </PeriodFilter>

      {page.state === 'loading' && <Loading />}
      {page.state === 'failed' && <Failed resource={page} />}
      {page.state === 'ready' && page.data.rows.length === 0 && (
        <Empty>
          {channel === 'wompi'
            ? 'Ningún crédito de Wompi quedó sin explicar en este período.'
            : 'No hay ingresos de este tipo en el período.'}
        </Empty>
      )}

      {page.state === 'ready' && page.data.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Descripción</th>
                  <th>Contraparte</th>
                  <th className="num">Monto</th>
                  <th>Por qué no se asignó</th>
                </tr>
              </thead>
              <tbody>
                {page.data.rows.map((credit) => (
                  <tr key={credit.movementId}>
                    <td>{credit.valueDate}</td>
                    <td>{credit.description}</td>
                    <td className="muted">{credit.counterparty ?? '—'}</td>
                    <td className="num">{show(credit.amount)}</td>
                    <td>
                      <code>{credit.reason}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page.data.page} onChange={update} noun="créditos" />
        </>
      )}
    </div>
  );
}
