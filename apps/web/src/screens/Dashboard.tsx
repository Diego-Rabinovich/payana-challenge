import type { ReconciliationDto, UnattributedCreditDto } from '@aa/contracts';
import { Link } from 'react-router-dom';
import { show } from '../api/client.js';
import { MoneyFunnel, type FunnelStep } from '../components/MoneyFunnel.js';
import { Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';
import { api } from '../api/client.js';

/**
 * "Where is my money?"
 *
 * The funnel answers it in one reading, and the counters below show amounts
 * next to counts — because seven exceptions worth ninety pesos and seven worth
 * forty million are not the same morning.
 */
export function Dashboard() {
  const resource = useResource(async () => {
    const [flow, unattributed] = await Promise.all([
      api.reconciliations(),
      api.unattributedCredits(),
    ]);
    return { items: flow.reconciliations, credits: unattributed.credits };
  });

  return (
    <Resolved resource={resource} what="la última corrida">
      {({ items, credits }) => (
        <>
          <MoneyFunnel steps={funnelOf(items)} />
          <Counters items={items} />
          <UnattributedCredits credits={credits} />
        </>
      )}
    </Resolved>
  );
}

function Counters({ items }: { items: readonly ReconciliationDto[] }) {
  const buckets = [
    { key: 'confirmed', label: 'Conciliado', match: (s: string) => s === 'CONFIRMED', tone: 'good' },
    { key: 'probable', label: 'Probable', match: (s: string) => s === 'PROBABLE', tone: 'warn' },
    { key: 'ambiguous', label: 'Ambiguo', match: (s: string) => s === 'AMBIGUOUS', tone: 'warn' },
    {
      key: 'unmatched',
      label: 'Sin conciliar',
      match: (s: string) => s === 'UNMATCHED' || s === 'UNRESOLVED_COMBINATORIAL',
      tone: 'bad',
    },
  ] as const;

  return (
    <section className="counters">
      {buckets.map((bucket) => {
        const matching = items.filter((item) => bucket.match(item.status));
        const cents = matching.reduce((total, item) => total + item.amounts.expectedNet.cents, 0);

        return (
          <Link key={bucket.key} to={`/excepciones?estado=${bucket.key}`} className="counter">
            <span className={`counter__dot counter__dot--${bucket.tone}`} aria-hidden="true" />
            <span className="counter__label">{bucket.label}</span>
            <strong className="counter__count">{matching.length}</strong>
            <span className="counter__amount">{formatTotal(cents)}</span>
          </Link>
        );
      })}
    </section>
  );
}

function UnattributedCredits({ credits }: { credits: readonly UnattributedCreditDto[] }) {
  if (credits.length === 0) return null;

  return (
    <section>
      <header className="section__header">
        <h2>Ingresos no atribuidos</h2>
        <p>Entraron al banco y ningún lote los reclamó. El sistema los vio y decidió no tocarlos.</p>
      </header>
      <table className="table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Descripción</th>
            <th>Contraparte</th>
            <th className="right">Monto</th>
          </tr>
        </thead>
        <tbody>
          {credits.map((credit) => (
            <tr key={credit.movementId}>
              <td>{credit.valueDate}</td>
              <td>{credit.description}</td>
              <td>{credit.counterparty ?? '—'}</td>
              <td className="right">{show(credit.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function funnelOf(items: readonly ReconciliationDto[]): FunnelStep[] {
  const sum = (pick: (item: ReconciliationDto) => number) =>
    items.reduce((total, item) => total + pick(item), 0);

  const gross = sum((item) => item.amounts.gross.cents);
  const deductions = sum((item) => item.amounts.deductions.cents);
  const expected = sum((item) => item.amounts.expectedNet.cents);
  const credited = sum((item) => item.amounts.observedNet?.cents ?? 0);

  return [
    { label: 'Ventas brutas', amount: money(gross), kind: 'start' },
    { label: 'Deducciones', amount: money(-deductions), kind: 'deduction' },
    { label: 'Neto esperado', amount: money(expected), kind: 'subtotal' },
    { label: 'Acreditado en el banco', amount: money(credited), kind: 'subtotal' },
    { label: 'Diferencia', amount: money(credited - expected), kind: 'result' },
  ];
}

/**
 * Only aggregates are composed here; every individual amount arrives already
 * formatted by the backend, so the rule itself still lives in one place.
 */
function money(cents: number) {
  return { cents, currency: 'COP' as const, formatted: formatTotal(cents) };
}

function formatTotal(cents: number): string {
  const digits = Math.abs(cents).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}$${whole},${digits.slice(-2)}`;
}
