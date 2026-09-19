import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatMoney } from '@aa/adapters';
import type { Evidence, MatchResult, ReadModel, ReconciliationReport } from '@aa/core';

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

function renderMarkdown(report: ReconciliationReport): string {
  const { totals } = report;
  const exceptions = report.matches
    .filter((match) => match.status !== 'CONFIRMED')
    .sort((a, b) => amountAtRisk(b) - amountAtRisk(a));

  return [
    '# Conciliación — Alimentos Alcázar',
    '',
    `Ruleset \`${report.rulesetVersion}\`${report.runId ? ` · corrida \`${report.runId}\`` : ''}`,
    '',
    '## Dónde está la plata',
    '',
    '| | |',
    '|---|---:|',
    `| Liquidaciones | ${totals.batches} |`,
    `| Neto esperado | ${formatMoney(totals.expectedNet)} |`,
    `| Acreditado en el banco | ${formatMoney(totals.observedNet)} |`,
    `| **Sin explicar** | **${formatMoney(totals.unexplained)}** |`,
    '',
    '### Por estado',
    '',
    ...Object.entries(totals.byStatus).map(([status, count]) => `- ${status}: ${count}`),
    '',
    `## Excepciones (${exceptions.length})`,
    '',
    ...(exceptions.length === 0
      ? ['Todas las liquidaciones conciliaron contra el banco.']
      : exceptions.flatMap(renderException)),
    '',
    `## Ingresos no atribuidos (${report.unattributed.length})`,
    '',
    ...(report.unattributed.length === 0
      ? ['Ninguno.']
      : [
          '| Fecha | Descripción | Contraparte | Monto |',
          '|---|---|---|---:|',
          ...report.unattributed.map(
            (credit) =>
              `| ${credit.valueDate.toString()} | ${credit.description} | ${credit.counterparty ?? '—'} | ${formatMoney(credit.amount)} |`,
          ),
        ]),
    '',
    '---',
    '',
    `Generado el ${new Date().toISOString()}. Cada conclusión cita los movimientos que relaciona,`,
    'la regla que usó y la evidencia que la sostiene. Los códigos de evidencia están',
    'documentados en `docs/EVIDENCE-CODES.md`.',
    '',
  ].join('\n');
}

function renderException(match: MatchResult): string[] {
  return [
    `### ${match.left.batchDate.toString()} · ${match.status}`,
    '',
    `Bruto ${formatMoney(match.amounts.gross)} · neto esperado ${formatMoney(match.amounts.expectedNet)}` +
      (match.amounts.observedNet ? ` · acreditado ${formatMoney(match.amounts.observedNet)}` : ''),
    '',
    ...match.confidence.components.map(renderEvidence),
    '',
    `Confianza ${match.confidence.score}/100 · regla \`${match.rule.id}\` v${match.rule.version}` +
      ` · ventana ${match.window.from.toString()} a ${match.window.to.toString()}`,
    ...(match.alternatives.length > 0
      ? [
          '',
          'Alternativas descartadas: ' +
            match.alternatives
              .map((alt) => `\`${alt.movementIds.join(' + ')}\` (${alt.score} pts, ${alt.rejectedBecause})`)
              .join(', '),
        ]
      : []),
    '',
  ];
}

/** Codes to sentences — the same table the UI uses, kept deliberately plain here. */
function renderEvidence(evidence: Evidence): string {
  const mark = evidence.passed ? '✓' : '✗';
  const values =
    evidence.expected || evidence.observed
      ? ` — esperado ${evidence.expected ?? '—'}, observado ${evidence.observed ?? '—'}`
      : '';
  return `- ${mark} \`${evidence.code}\`${values}${evidence.detail ? ` (${evidence.detail})` : ''}`;
}

function amountAtRisk(match: MatchResult): number {
  return Math.abs(match.amounts.delta?.cents ?? match.amounts.expectedNet.cents);
}
