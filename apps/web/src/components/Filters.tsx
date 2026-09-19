import type { OffsetPageDto } from '@aa/contracts';
import { useSearchParams } from 'react-router-dom';

/**
 * The period and the page, kept in the URL.
 *
 * Not in component state: an exception is something you send to someone, and
 * "mirá esta" has to survive being pasted into a chat. Putting the filter in
 * the address bar also means the back button does what a person expects.
 */

export interface Filter {
  readonly from?: string;
  readonly to?: string;
  readonly status?: string;
  readonly offset: number;
  readonly limit: number;
}

export function useFilter(defaults: { limit?: number } = {}): [Filter, (patch: Partial<Filter>) => void] {
  const [params, setParams] = useSearchParams();
  const limit = Number(params.get('limit') ?? defaults.limit ?? 25);

  const filter: Filter = {
    ...(params.get('from') ? { from: params.get('from')! } : {}),
    ...(params.get('to') ? { to: params.get('to')! } : {}),
    ...(params.get('status') ? { status: params.get('status')! } : {}),
    offset: Number(params.get('offset') ?? 0),
    limit,
  };

  const update = (patch: Partial<Filter>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    // Any change to what is being asked for starts again at the first page;
    // staying on page 4 of a different question shows an empty table.
    if (!('offset' in patch)) next.delete('offset');
    setParams(next, { replace: true });
  };

  return [filter, update];
}

export function PeriodFilter({
  filter,
  onChange,
  children,
}: {
  filter: Filter;
  onChange: (patch: Partial<Filter>) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="filters">
      <label className="field">
        <span>Desde</span>
        <input
          type="date"
          value={filter.from ?? ''}
          onChange={(event) => onChange({ from: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Hasta</span>
        <input
          type="date"
          value={filter.to ?? ''}
          onChange={(event) => onChange({ to: event.target.value })}
        />
      </label>
      {children}
      {(filter.from ?? filter.to ?? filter.status) !== undefined && (
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => onChange({ from: '', to: '', status: '' })}
        >
          Limpiar
        </button>
      )}
    </div>
  );
}

export function StatusFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (status: string) => void;
}) {
  return (
    <label className="field">
      <span>Estado</span>
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">Todos</option>
        <option value="confirmed">Conciliado</option>
        <option value="probable">Probable</option>
        <option value="ambiguous">Ambiguo</option>
        <option value="unmatched">Sin conciliar</option>
      </select>
    </label>
  );
}

/**
 * Where you are in the whole collection.
 *
 * The total matters as much as the buttons: "25 de 56" tells a reader the
 * table is a window, which an endless scroll of rows never does.
 */
export function Pager({
  page,
  onChange,
  noun = 'resultados',
}: {
  page: OffsetPageDto;
  onChange: (patch: { offset: number }) => void;
  noun?: string;
}) {
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  const canPrevious = page.offset > 0;
  const canNext = last < page.total;

  if (page.total <= page.limit && !canPrevious) {
    return (
      <div className="pager">
        <span>
          {page.total} {noun}
        </span>
      </div>
    );
  }

  return (
    <div className="pager">
      <span>
        {first}–{last} de {page.total} {noun}
      </span>
      <span className="pager__spacer" />
      <button
        type="button"
        className="btn"
        disabled={!canPrevious}
        onClick={() => onChange({ offset: Math.max(0, page.offset - page.limit) })}
      >
        Anterior
      </button>
      <button
        type="button"
        className="btn"
        disabled={!canNext}
        onClick={() => onChange({ offset: page.offset + page.limit })}
      >
        Siguiente
      </button>
    </div>
  );
}
