import { parseArgs } from 'node:util';
import { buildDependencies, buildReadModel, formatMoney } from '@aa/adapters';
import { readEnv } from './env.js';
import { writeReport } from './report.js';

/**
 * The headless door.
 *
 * Argument parsing is `node:util`, so the CLI carries no dependency of its
 * own. Ingestion is batch work by nature — twelve statements is not a
 * request/response shape — and deliverable 9 needs a report someone can
 * produce without a browser.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] ?? 'help';

if (values.help || command === 'help') {
  console.log(`
  aa <comando> [opciones]

    run       Ingesta las fuentes, concilia las dos fases y guarda los resultados
    report    Escribe report.md y report.json de la última corrida
    demo      run + report sobre el período completo

  Opciones
    --from    Fecha de inicio (YYYY-MM-DD)
    --to      Fecha de fin   (YYYY-MM-DD)
    --out     Destino de los artefactos (por defecto data/out)
`);
  process.exit(0);
}

const config = readEnv();
const deps = await buildDependencies(config);
const readModel = buildReadModel(deps, '0.1.0');

try {
  const from = values.from ?? '2026-01-01';
  const to = values.to ?? '2026-04-30';

  if (command === 'run' || command === 'demo') {
    console.log(`Corriendo conciliación de ${from} a ${to}…`);
    const run = await readModel.runs.start({ from, to });
    console.log(`  corrida ${run.id} · ruleset ${run.rulesetVersion}`);

    const report = await readModel.flow.flowReport();
    if (report) {
      console.log(`  ${report.totals.batches} liquidaciones`);
      for (const [status, count] of Object.entries(report.totals.byStatus)) {
        console.log(`    ${status.padEnd(26)} ${count}`);
      }
      console.log(`  neto esperado    ${formatMoney(report.totals.expectedNet)}`);
      console.log(`  acreditado       ${formatMoney(report.totals.observedNet)}`);
      console.log(`  sin explicar     ${formatMoney(report.totals.unexplained)}`);
      console.log(`  no atribuidos    ${report.unattributed.length} créditos`);
    }
  }

  if (command === 'report' || command === 'demo') {
    const written = await writeReport(readModel, values.out ?? `${config.dataDir}/out`);
    for (const file of written) console.log(`  escrito ${file}`);
  }
} finally {
  await deps.close();
}
