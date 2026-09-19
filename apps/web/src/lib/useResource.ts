import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.js';

/**
 * A request and its three outcomes.
 *
 * Every screen needs loading, failure and success, and writing that by hand
 * each time is how a UI ends up with five different blank screens. One hook,
 * one shape, and the failure carries a hint instead of a shrug.
 */
export type Resource<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly message: string; readonly hint?: string }
  | { readonly state: 'ready'; readonly data: T };

export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[] = []): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setResource({ state: 'loading' });

    void load()
      .then((data) => {
        if (!cancelled) setResource({ state: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResource(describe(error));
      });

    return () => {
      // Navigating away mid-flight must not write into an unmounted screen.
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return resource;
}

function describe(error: unknown): Resource<never> {
  if (error instanceof ApiError) {
    return {
      state: 'failed',
      message: error.message,
      ...(error.status === 404
        ? { hint: 'Todavía no hay una corrida sobre este período. Ejecutá `make demo`.' }
        : {}),
    };
  }
  return {
    state: 'failed',
    message: 'La API no respondió.',
    hint: 'Verificá que esté levantada en VITE_API_BASE_URL.',
  };
}
