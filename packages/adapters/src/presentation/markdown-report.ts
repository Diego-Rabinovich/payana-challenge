import { formatMoney, humaniseAmounts } from './money-format.js';
import {
  type ErpReconciliationReport,
  type Evidence,
  type MatchResult,
  Money,
  type ReconciliationReport,
  amountOfConcept,
} from '@aa/core';

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
export function renderMarkdown(
  report: ReconciliationReport,
  /** La fase 3, por diario. Sin ella el reporte sólo cuenta la mitad. */
  erp: Readonly<Record<string, ErpReconciliationReport>> = {},
): string {
  const { totals } = report;
  const exceptions = report.matches
    .filter((match) => match.status !== 'CONFIRMED')
    .sort((a, b) => amountAtRisk(b) - amountAtRisk(a));

  return [
    '# Conciliación — Alimentos Alcázar',
    '',
    `Ruleset \`${report.rulesetVersion}\`${report.runId ? ` · corrida \`${report.runId}\`` : ''}`,
    '',
    '## Wompi → Bancolombia',
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
    ...renderErp(report, erp),
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
    'la regla que usó y la evidencia que la sostiene. Qué significa y cuánto vale cada código',
    'está en la rúbrica de `report.json` y en el glosario de la consola.',
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
      ? ` — esperado ${humaniseAmounts(evidence.expected ?? '—')}, observado ${humaniseAmounts(evidence.observed ?? '—')}`
      : '';
  return `- ${mark} \`${evidence.code}\`${values}${evidence.detail ? ` (${humaniseAmounts(evidence.detail)})` : ''}`;
}

function amountAtRisk(match: MatchResult): number {
  return Math.abs(match.amounts.delta?.cents ?? match.amounts.expectedNet.cents);
}

/**
 * La fase 3, para un CFO: cuánto coincide, qué falta y qué está mal registrado.
 *
 * Corto a propósito. El detalle línea por línea está en la consola y en
 * `report.json`; acá va lo que alguien tiene que saber para decidir.
 */
function renderErp(
  report: ReconciliationReport,
  erp: Readonly<Record<string, ErpReconciliationReport>>,
): string[] {
  const journals = Object.values(erp);
  if (journals.length === 0) return [];

  const count = (journal: ErpReconciliationReport, ...statuses: string[]) =>
    statuses.reduce(
      (total, status) =>
        total + (journal.totals.byStatus[status as keyof typeof journal.totals.byStatus] ?? 0),
      0,
    );

  const rows = journals.map(
    (journal) =>
      `| ${journal.journalName} | ${count(journal, 'MATCHED')} | ${count(journal, 'INCOMPLETE_ENTRY')} | ` +
      `${count(journal, 'MISSING_IN_ERP')} | ${count(journal, 'MISSING_IN_LEDGER')} | ` +
      `${count(journal, 'AMOUNT_MISMATCH', 'DATE_SHIFT', 'DUPLICATE_IN_ERP')} |`,
  );

  // Lo que les falta a los asientos de venta que existen: las tres deducciones.
  const incomplete = journals.flatMap((journal) =>
    journal.lines.filter((line) => line.status === 'INCOMPLETE_ENTRY' && line.correction),
  );
  const lacking = Money.sum(
    incomplete.flatMap((line) =>
      (['FEE', 'TAX', 'WITHHOLDING'] as const).map((concept) =>
        amountOfConcept(line.correction!, concept),
      ),
    ),
  );

  // Faltantes que sí son de Wompi —tienen asiento propuesto— y los que no.
  const missing = journals.map((journal) => {
    const lines = journal.lines.filter((line) => line.status === 'MISSING_IN_ERP');
    const inScope = lines.filter((line) => line.correction);
    return {
      name: journal.journalName,
      count: inScope.length,
      amount: Money.sum(inScope.map((line) => (line.ledgerAmount ?? Money.zero()).abs())),
      outOfScope: lines.length - inScope.length,
    };
  });
  const outOfScope = missing.reduce((total, journal) => total + journal.outOfScope, 0);

  return [
    '## Contra el ERP (Odoo)',
    '',
    '| Diario | Conciliadas | Incompletas | Faltan en el ERP | Faltan en el ledger | Otras diferencias |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows,
    '',
    `**Wompi retuvo ${formatMoney(report.totals.deductions)} en el período** —comisión, IVA y ` +
      `retención${report.totals.deductionsAreDerived ? ', derivados de la diferencia entre lo vendido y lo acreditado' : ''}— ` +
      '**y el ERP no registró esas partidas.** Las ventas están asentadas al bruto y ningún asiento ' +
      'toca las cuentas de comisión, IVA ni retención.' +
      (incomplete.length > 0
        ? ` Por eso los ${incomplete.length} asientos de venta que existen quedan incompletos: ` +
          `les faltan ${formatMoney(lacking)}.`
        : ''),
    '',
    'Asientos de Wompi que faltan: ' +
      missing
        .filter((journal) => journal.count > 0)
        .map((journal) => `${journal.count} en ${journal.name} (${formatMoney(journal.amount)})`)
        .join(' y ') +
      '.' +
      (outOfScope > 0
        ? ` Los otros ${outOfScope} movimientos sin asiento —comisiones e intereses del banco, ` +
          'pagos a terceros— están fuera del alcance y no se propone corregirlos.'
        : ''),
    '',
  ];
}
