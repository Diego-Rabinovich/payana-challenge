/**
 * Turning a PDF into rows of cells.
 *
 * `pdfjs-dist` does the actual PDF work — decompression, fonts, glyph
 * positions. What it hands back is a flat list of text runs with their
 * transforms, because a PDF has no concept of a table: the columns a reader
 * sees are an artefact of where the glyphs landed.
 *
 * So the only thing written here is the clustering: group runs that share a
 * baseline into a row, order them by x, and let the caller say which x range
 * is which column. It is about thirty lines because no Node library does table
 * extraction well (tabula, which does, is Java).
 */

export interface Cell {
  readonly x: number;
  readonly text: string;
}

export interface Row {
  readonly page: number;
  readonly y: number;
  readonly cells: readonly Cell[];
  /** Every cell joined, for header lines that span the width. */
  readonly line: string;
}

/** Runs within this many points of each other belong to the same visual row. */
const BASELINE_TOLERANCE = 2;

export async function extractRows(payload: Uint8Array): Promise<Row[]> {
  const pdfjs = await loadPdfjs();
  const document = await pdfjs.getDocument({ data: payload, useSystemFonts: true }).promise;

  const rows: Row[] = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    rows.push(...clusterIntoRows(page, content.items));
  }
  return rows;
}

function clusterIntoRows(page: number, items: readonly PdfTextItem[]): Row[] {
  const byBaseline = new Map<number, Cell[]>();

  for (const item of items) {
    if (!item.str?.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    if (x === undefined || y === undefined) continue;
    // Snap to a nearby baseline: sub-pixel differences would otherwise split
    // one visual row into several.
    const baseline = Math.round(y);
    const key =
      [...byBaseline.keys()].find((existing) => Math.abs(existing - baseline) <= BASELINE_TOLERANCE) ??
      baseline;

    const bucket = byBaseline.get(key);
    const cell = { x: Math.round(x), text: item.str.trim() };
    if (bucket) bucket.push(cell);
    else byBaseline.set(key, [cell]);
  }

  return [...byBaseline.entries()]
    // PDF y grows upward, so reading order is descending.
    .sort(([a], [b]) => b - a)
    .map(([y, cells]) => {
      const ordered = [...cells].sort((a, b) => a.x - b.x);
      return { page, y, cells: ordered, line: ordered.map((cell) => cell.text).join(' ') };
    });
}

/** The first cell whose x falls in `[from, to)`. */
export function cellIn(row: Row, from: number, to: number): string | undefined {
  return row.cells.find((cell) => cell.x >= from && cell.x < to)?.text;
}

/** The cell immediately to the right of a label, on the same row. */
export function valueAfter(row: Row, label: string): string | undefined {
  const index = row.cells.findIndex((cell) => cell.text.toUpperCase().startsWith(label));
  return index === -1 ? undefined : row.cells[index + 1]?.text;
}

interface PdfTextItem {
  readonly str?: string;
  readonly transform: readonly number[];
}

interface PdfjsModule {
  getDocument(options: { data: Uint8Array; useSystemFonts: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
    }>;
  };
}

let cached: PdfjsModule | undefined;

/**
 * Loaded lazily: pdfjs is a large module, and a run that only touches Wompi
 * and Odoo should not pay for it.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  cached ??= (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  return cached;
}
