import type { ReactNode } from 'react';

/**
 * Una sección que arranca cerrada.
 *
 * Abrir una conciliación mostraba de golpe la evidencia, los pagos del lote,
 * las filas del extracto y los candidatos descartados: cuatro tablas de una
 * vez, y la fila siguiente a dos pantallas de distancia. Casi siempre lo que
 * se quiere ver es una de las cuatro.
 *
 * Es `<details>` nativo en vez de estado propio: se abre sin JavaScript,
 * responde al teclado y el navegador ya sabe anunciarlo. Un `useState` acá
 * sería reimplementar peor algo que el HTML hace bien.
 */
export function Collapsible({
  title,
  count,
  children,
}: {
  title: string;
  /** Lo que hay adentro, dicho antes de abrir. Sin esto, abrir es a ciegas. */
  count?: string;
  children: ReactNode;
}) {
  return (
    <details className="fold">
      <summary className="fold__summary">
        <span className="fold__title">{title}</span>
        {count && <span className="fold__count">{count}</span>}
      </summary>
      <div className="fold__body">{children}</div>
    </details>
  );
}
