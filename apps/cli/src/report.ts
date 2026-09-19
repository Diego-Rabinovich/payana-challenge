import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderMarkdown } from '@aa/adapters';
import type { ReadModel } from '@aa/core';

/**
 * Deliverable 9: the system's output over the provided data.
 *
 * Two renderings of one truth — Markdown for a person, JSON for a machine —
 * and neither invents anything. The prose is assembled from the evidence codes
 * the engine emitted, so the report and the screen cannot disagree about what
 * a conclusion says. See ADR-0007.
 */
export async function writeReport(readModel: ReadModel, outDir: string): Promise<string[]> {
  const report = await readModel.flow.flowReport();
  if (!report) return [];

  await mkdir(outDir, { recursive: true });

  const files: string[] = [];
  const markdown = join(outDir, 'report.md');
  const json = join(outDir, 'report.json');

  await writeFile(markdown, renderMarkdown(report), 'utf8');
  files.push(markdown);

  await writeFile(json, JSON.stringify(report, null, 2), 'utf8');
  files.push(json);

  return files;
}

