import type { ReconciliationDto, SettlementBatchDto } from '@aa/contracts';
import { Link } from 'react-router-dom';
import { api, show } from '../api/client.js';
import { EvidenceList } from '../components/EvidenceList.js';
import { StatusChip } from '../components/StatusChip.js';
import { Empty, Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';
import { useState } from 'react';

/**
 * A day of sales and what happened to it.
 *
 * The deduction column carries a badge saying whether the source reported the
 * figures or the system derived them — the two are different claims, and a
 * reader who cannot tell them apart will over-trust the weaker one.
 */
export function Settlements() {
  const resource = useResource(async () => {
    const [batches, flow] = await Promise.all([api.settlementBatches(), api.reconciliations()]);
    return { batches: batches.batches, matches: flow.reconciliations };
  });

  return (
    <Resolved resource={resource} what="las liquidaciones">
      {({ batches, matches }) =>
        batches.length === 0 ? (
          <Empty title="Sin liquidaciones">
            No hay ventas ingestadas para este período todavía.
          </Empty>
        ) : (
          <SettlementTable batches={batches} matches={matches} />
        )
      }
    </Resolved>
  );
}

function SettlementTable({
  batches,
  matches,
}: {
  batches: readonly SettlementBatchDto[];
  matches: readonly ReconciliationDto[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const matchOf = (batchId: string) => matches.find((match) => match.left.batchId === batchId);

  return (
    <section>
      <header className="section__header">
        <h2>Liquidaciones</h2>
        <p>Una fila por jornada: lo que se vendió, lo que se dedujo y lo que llegó.</p>
      </header>

      <table className="table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th className="right">Pagos</th>
            <th className="right">Bruto</th>
            <th>Deducciones</th>
            <th className="right">Neto esperado</th>
            <th className="right">Acreditado</th>
            <th className="right">Δ</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const match = matchOf(batch.id);
            const derived = batch.deductions.some((deduction) => deduction.basis === 'IMPLIED');

            return (
              <>
                <tr
                  key={batch.id}
                  className="row--clickable"
                  onClick={() => setOpen(open === batch.id ? null : batch.id)}
                >
                  <td>{batch.batchDate}</td>
                  <td className="right">{batch.chargeIds.length}</td>
                  <td className="right">{show(batch.gross)}</td>
                  <td>
                    <span className={`badge badge--${derived ? 'derived' : 'reported'}`}>
                      {derived ? 'derivadas' : 'informadas'}
                    </span>
                  </td>
                  <td className="right">{show(batch.expectedNet)}</td>
                  <td className="right">{show(match?.amounts.observedNet)}</td>
                  <td className="right">{show(match?.amounts.delta)}</td>
                  <td>{match ? <StatusChip status={match.status} /> : '—'}</td>
                </tr>

                {open === batch.id && match && (
                  <tr key={`${batch.id}-detail`}>
                    <td colSpan={8} className="row__detail">
                      <EvidenceList confidence={match.confidence} />
                      <p className="muted">
                        {batch.chargeIds.length} pagos ·{' '}
                        <Link to={`/movimientos/${batch.chargeIds[0]}`}>ver el linaje del primero</Link>
                      </p>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
