import type { MoneyDto } from '@aa/contracts';
import { show } from '../api/client.js';

export interface FunnelStep {
  readonly label: string;
  readonly amount: MoneyDto;
  readonly kind: 'start' | 'deduction' | 'subtotal' | 'result';
}

/**
 * Where the money went, as a waterfall.
 *
 * The CFO's first question is not "how many exceptions" but "how much is
 * missing", so the last step is the difference and it is the loudest thing on
 * the screen. Every bar is clickable down to the movements behind it.
 */
export function MoneyFunnel({ steps }: { steps: readonly FunnelStep[] }) {
  const widest = Math.max(...steps.map((step) => Math.abs(step.amount.cents)), 1);

  return (
    <ol className="funnel">
      {steps.map((step) => (
        <li key={step.label} className={`funnel__step funnel__step--${step.kind}`}>
          <span className="funnel__label">{step.label}</span>
          <span
            className="funnel__bar"
            style={{ width: `${(Math.abs(step.amount.cents) / widest) * 100}%` }}
            aria-hidden="true"
          />
          <span className="funnel__amount">{show(step.amount)}</span>
        </li>
      ))}
    </ol>
  );
}
