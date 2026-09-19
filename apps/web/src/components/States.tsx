import type { HealthDto } from '@aa/contracts';
import type { ReactNode } from 'react';
import type { Resource } from '../lib/useResource.js';

/**
 * The states that are not the happy path.
 *
 * Half of what a CFO actually sees is an empty screen, a stale source or a
 * rejected file. Designing those is not polish: a blank page that says nothing
 * is indistinguishable from "everything reconciled", and those are opposite
 * answers.
 */

export function Loading({ what = 'los datos' }: { what?: string }) {
  return <div className="state">Cargando {what}…</div>;
}

export function Failed({
  resource,
  message,
  hint,
}: {
  resource?: Extract<Resource<unknown>, { state: 'failed' }>;
  message?: string;
  hint?: string;
}) {
  const text = resource?.message ?? message ?? 'La API no respondió.';
  const note = resource?.hint ?? hint;

  return (
    <div className="state">
      <div className="state__title">No se pudo leer esta información</div>
      <p>{text}</p>
      {note && <p className="faint">{note}</p>}
    </div>
  );
}

export function Empty({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="state">
      {title && <div className="state__title">{title}</div>}
      <p>{children}</p>
    </div>
  );
}

/** Renders a resource's three outcomes without each screen repeating them. */
export function Resolved<T>({
  resource,
  what,
  children,
}: {
  resource: Resource<T>;
  what?: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.state === 'loading') return <Loading {...(what ? { what } : {})} />;
  if (resource.state === 'failed') return <Failed resource={resource} />;
  return <>{children(resource.data)}</>;
}

/**
 * A source that did not answer.
 *
 * Shown rather than hidden, because a report built on yesterday's Odoo is a
 * different claim from one built on today's, and the reader has to know which.
 */
export function SourceBanner({ health }: { health: HealthDto }) {
  const degraded = health.sources.filter((source) => source.state !== 'ready');
  if (degraded.length === 0) return null;

  return (
    <aside className="banner banner--warn" role="status">
      {degraded.map((source) => (
        <span key={source.id}>
          <strong>{source.id}</strong>{' '}
          {source.state === 'stale'
            ? `no respondió; estos datos son del ${source.asOf?.slice(0, 10) ?? 'último snapshot'}.`
            : 'no está disponible. Lo que sigue puede estar incompleto.'}
        </span>
      ))}
    </aside>
  );
}
