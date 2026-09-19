import { formatMoney } from './money-format.js';
import type { Evidence, MatchResult, ReconciliationReport } from '@aa/core';

/**
 * The run, written for a person.
 *
 * It lives in the adapter layer rather than in the CLI because two deliveries
 * need it: the CLI writes it to data/out, and the API serves it as a download.
 * Keeping a second copy in the CLI is how a report and a screen start
 * disagreeing about what a conclusion says. See ADR-0007.
 *
 * Nothing here invents prose: every sentence is assembled from the evidence
 * codes the engine emitted.
 */
export function renderMarkdown(report: ReconciliationReport): string {
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
