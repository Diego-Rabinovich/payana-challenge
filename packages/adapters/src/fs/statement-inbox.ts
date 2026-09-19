import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { StatementFile } from '@aa/core';

/**
 * The directory the bank statements live in, as an inbox.
 *
 * Deliberately the same directory the `LocalFileConnector` reads: uploading a
 * statement and dropping one in by hand are the same act, so a run behaves
 * identically either way and there is no second code path to keep honest.
 *
 * Ingestion keys raw records on their content hash, so uploading the same
 * statement twice costs a file and changes nothing downstream.
 */

const ALLOWED = '.pdf';

export async function listStatements(directory: string): Promise<StatementFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const files = await Promise.all(
    names
      .filter((name) => name.toLowerCase().endsWith(ALLOWED))
      .map(async (name) => {
        const info = await stat(join(directory, name));
        return { name, bytes: info.size, receivedAt: info.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export async function saveStatement(
  directory: string,
  filename: string,
  content: Uint8Array,
): Promise<StatementFile> {
  const name = safeName(filename);
  if (extname(name).toLowerCase() !== ALLOWED) {
    throw new Error(`Only ${ALLOWED} statements are accepted, got ${name}`);
  }
  if (!looksLikePdf(content)) {
    // Fail here rather than at parse time: "this is not a PDF" is a far more
    // useful thing to tell someone than a stack trace out of pdfjs.
    throw new Error(`${name} is not a PDF`);
  }

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content);
  const info = await stat(join(directory, name));
  return { name, bytes: info.size, receivedAt: info.mtime.toISOString() };
}

export async function readStatement(directory: string, filename: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(directory, safeName(filename))));
}

/** Strips any path, so an upload cannot write outside the inbox. */
function safeName(filename: string): string {
  return basename(filename).replace(/[^\w.\- ]+/g, '_');
}

function looksLikePdf(content: Uint8Array): boolean {
  return (
    content.length > 4 &&
    content[0] === 0x25 &&
    content[1] === 0x50 &&
    content[2] === 0x44 &&
    content[3] === 0x46
  );
}
