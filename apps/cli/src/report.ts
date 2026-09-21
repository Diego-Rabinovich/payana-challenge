import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LATEST_RUN, type ReadModel } from '@aa/core';

/**
 * Deliverable 9: the system's output over the provided data.
 *
 * Two renderings of one truth — Markdown for a person, JSON for a machine —
 * and neither invents anything. The prose is assembled from the evidence codes
 * the engine emitted, so the report and the screen cannot disagree about what
 * a conclusion says. See ADR-0007.
 */
export async function writeReport(
  readModel: ReadModel,
  outDir: string,
  /** Cuál. Por defecto la última, dicho por su nombre en vez de por omisión. */
  runId = LATEST_RUN,
): Promise<string[]> {
  const resolved = await readModel.runs.resolve(runId);
  if (!resolved) return [];

  // Por el mismo camino que la descarga de la consola: el archivo en disco y el
  // que se baja por la API no pueden ser dos cosas distintas.
  const [markdownText, jsonText] = await Promise.all([
    readModel.runs.reportArtifact(resolved, 'md'),
    readModel.runs.reportArtifact(resolved, 'json'),
  ]);
  if (!markdownText || !jsonText) return [];

  await mkdir(outDir, { recursive: true });

  const files: string[] = [];
  const markdown = join(outDir, 'report.md');
  const json = join(outDir, 'report.json');

  await writeFile(markdown, markdownText, 'utf8');
  files.push(markdown);

  await writeFile(json, jsonText, 'utf8');
  files.push(json);

  return files;
}

