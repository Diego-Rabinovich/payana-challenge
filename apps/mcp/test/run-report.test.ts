import { describe, expect, it } from 'vitest';
import { EVIDENCE_CODES, RunReportDto } from '@aa/contracts';
import { renderMarkdown, toRunReportDto } from '@aa/adapters';
import { type RunRecord, evidence } from '@aa/core';
import { stubReadModel } from './support/stub-read-model.js';

/**
 * The structured output for a model: `data/out/report.json`.
 *
 * Vive junto a los tests del MCP porque es el mismo usuario visto de otro lado:
 * el MCP es la IA preguntando en vivo, este archivo es la IA leyendo lo que la
 * corrida concluyó. Las dos tienen que hablar el mismo esquema.
 */

const model = stubReadModel();

const run: RunRecord = {
  id: 'run_test',
  startedAt: '2026-09-21T00:00:00.000Z',
  rulesetVersion: 'v1',
  range: { from: '2026-01-01', to: '2026-04-30' },
  inputHashes: {},
};

async function report() {
  const flow = await model.flow.flowReport('run_test');
  const erp = await model.erp.erpReconciliation({ journalKey: 'wompi', runId: 'run_test' });
  return toRunReportDto({
    run,
    flow: flow!,
    erp: { wompi: erp! },
    ruleSet: model.ruleSet,
    accountMap: model.accountMap,
  });
}

describe('the structured run report', () => {
  it('validates against the published schema', async () => {
    // Ida y vuelta por JSON: lo que se valida es el archivo, no el objeto en memoria.
    const enDisco = JSON.parse(JSON.stringify(await report()));
    expect(() => RunReportDto.parse(enDisco)).not.toThrow();
  });

  it('carries both phases and the rubric, so it reads without anything else', async () => {
    const result = await report();

    expect(result.reconciliations.length).toBeGreaterThan(0);
    expect(Object.keys(result.erp)).toContain('wompi');
    expect(result.rubric.codes.map((entry) => entry.code)).toEqual([...EVIDENCE_CODES]);
  });

  it('never leaks raw cents into prose a model would quote', async () => {
    // El objeto interno guarda «COP 2941468300» dentro de las explicaciones y
    // sólo el presenter lo formatea. Si eso se escapa, un modelo lo cita tal
    // cual y el CFO recibe un número de diez dígitos sin separadores. Los datos
    // de ejemplo no traen ninguno, así que se agrega uno como el real.
    const flow = (await model.flow.flowReport('run_test'))!;
    const [first, ...rest] = flow.matches;
    const conCentavos = {
      ...flow,
      matches: [
        {
          ...first!,
          confidence: {
            ...first!.confidence,
            components: [
              ...first!.confidence.components,
              evidence('SETTLEMENT_MERGED', 'INTEGRITY', false, {
                detail: 'los dos suman COP 2941468300 y el crédito está 4,31% por debajo',
              }),
            ],
          },
        },
        ...rest,
      ],
    };

    const json = JSON.stringify(
      toRunReportDto({
        run,
        flow: conCentavos,
        erp: {},
        ruleSet: model.ruleSet,
        accountMap: model.accountMap,
      }),
    );

    expect(json).not.toMatch(/COP \d/);
    expect(json).toContain('$29.414.683,00');
  });
});

describe('the report for the CFO', () => {
  it('cuenta las dos fases, no sólo la del banco', async () => {
    // Cubría sólo la fase 2: el ERP no aparecía en ninguna línea, y la pregunta
    // del enunciado termina en «qué está mal registrado en el ERP».
    const flow = (await model.flow.flowReport('run_test'))!;
    const erp = (await model.erp.erpReconciliation({ journalKey: 'wompi', runId: 'run_test' }))!;
    const markdown = renderMarkdown(flow, { wompi: erp });

    expect(markdown).toContain('## Contra el ERP (Odoo)');
    expect(markdown).toContain(erp.journalName);
  });

  it('shows amounts a person can read, not cents', async () => {
    // Imprimía 46 líneas con «COP 2593689600»: centavos, que leídos como pesos
    // son cien veces el monto real. Es el reporte que se lleva a una reunión.
    const flow = (await model.flow.flowReport('run_test'))!;
    const [first, ...rest] = flow.matches;
    const markdown = renderMarkdown({
      ...flow,
      matches: [
        {
          ...first!,
          status: 'UNMATCHED',
          confidence: {
            ...first!.confidence,
            components: [
              ...first!.confidence.components,
              evidence('SETTLEMENT_MERGED', 'INTEGRITY', false, {
                expected: 'una acreditación propia de COP 2593689600',
                detail: 'los dos suman COP 2941468300',
              }),
            ],
          },
        },
        ...rest,
      ],
    });

    expect(markdown).not.toMatch(/COP \d/);
    expect(markdown).toContain('$25.936.896,00');
  });
});
