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

export function Loading({ what }: { what: string }) {
  return <p className="muted">Cargando {what}…</p>;
}

export function Failed({ message, hint }: { message: string; hint?: string }) {
  return (
    <section className="empty">
      <h2>No se pudo leer esta información</h2>
      <p>{message}</p>
      {hint && <p className="muted">{hint}</p>}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

/** Renders a resource's three outcomes without each screen repeating them. */
export function Resolved<T>({
  resource,
  what,
  children,
}: {
  resource: Resource<T>;
  what: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.state === 'loading') return <Loading what={what} />;
  if (resource.state === 'failed') {
    return <Failed message={resource.message} {...(resource.hint ? { hint: resource.hint } : {})} />;
  }
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
    <aside className="banner" role="status">
      {degraded.map((source) => (
        <p key={source.id}>
          <strong>{source.id}</strong>{' '}
          {source.state === 'stale'
            ? `no respondió; estos datos son del ${source.asOf?.slice(0, 10) ?? 'último snapshot'}.`
            : 'no está disponible. Lo que sigue puede estar incompleto.'}
        </p>
      ))}
    </aside>
  );
}
