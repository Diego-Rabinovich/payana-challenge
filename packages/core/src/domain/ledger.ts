import { Temporal } from '@js-temporal/polyfill';
import type { AccountId } from './ids.js';
import { Money } from './money.js';
import type { Movement, MovementType } from './movement.js';

/**
 * A ledger is a projection over movements, not a stored entity: we persist
 * movements and assemble this on read. That avoids a materialised balance
 * drifting out of sync with the movements it claims to summarise.
 *
 * This is one of only two classes in the domain. It holds no invariant; it
 * exists because `ledger.balanceAt(d)` reads better than `balanceAt(l, d)`.
 */
export class Ledger {
  readonly movements: readonly Movement[];

  constructor(
    readonly accountId: AccountId,
    movements: readonly Movement[],
  ) {
    this.movements = [...movements].sort(compareByDateThenId);
  }

  /** Closing balance on `date`, inclusive. */
  balanceAt(date: Temporal.PlainDate): Money {
    return Money.sum(
      this.movements
        .filter((m) => Temporal.PlainDate.compare(m.valueDate, date) <= 0)
        .map((m) => m.amount),
    );
  }

  /** Movements in `[from, to]`, both inclusive. */
  between(from: Temporal.PlainDate, to: Temporal.PlainDate): Movement[] {
    return this.movements.filter(
      (m) =>
        Temporal.PlainDate.compare(m.valueDate, from) >= 0 &&
        Temporal.PlainDate.compare(m.valueDate, to) <= 0,
    );
  }

  byType(...types: readonly MovementType[]): Movement[] {
    const wanted = new Set(types);
    return this.movements.filter((m) => wanted.has(m.type));
  }

  /** Movements sharing an external id, e.g. the four parts of one sale. */
  byExternalId(externalId: string): Movement[] {
    return this.movements.filter((m) => m.externalId === externalId);
  }

  total(): Money {
    return Money.sum(this.movements.map((m) => m.amount));
  }

  isEmpty(): boolean {
    return this.movements.length === 0;
  }
}

/** Deterministic ordering: same movements always produce the same sequence. */
function compareByDateThenId(a: Movement, b: Movement): number {
  const byDate = Temporal.PlainDate.compare(a.valueDate, b.valueDate);
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
