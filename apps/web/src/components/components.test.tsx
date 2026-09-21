import type { ConfidenceDto, HealthDto, ProposedEntryDto } from '@aa/contracts';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConfidenceMeter, EvidenceList, StatusChip } from './Confidence.js';
import { MoneyFunnel, type FunnelStep } from './MoneyFunnel.js';
import { ProposedEntryTable } from './ProposedEntryTable.js';
import { Empty, Failed, Loading, SourceBanner } from './States.js';

const money = (cents: number) => ({
  cents,
  currency: 'COP' as const,
  formatted: `$${Math.abs(cents / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`,
});

describe('MoneyFunnel (F05-T02)', () => {
  const steps: FunnelStep[] = [
    { label: 'Ventas brutas', amount: money(31_754_900), kind: 'start' },
    { label: 'Deducciones', amount: money(-1_411_948), kind: 'deduction' },
    { label: 'Neto esperado', amount: money(30_342_952), kind: 'subtotal' },
    { label: 'Acreditado en el banco', amount: money(30_342_952), kind: 'subtotal' },
    { label: 'Diferencia', amount: money(0), kind: 'result' },
  ];

  it('adds up: gross less deductions equals the expected net', () => {
    const [gross, deductions, expected] = steps;
    expect(gross!.amount.cents + deductions!.amount.cents).toBe(expected!.amount.cents);
  });

});

describe('EvidenceList (F05-T03)', () => {
  const ambiguous: ConfidenceDto = {
    score: 100,
    band: 'AMBIGUOUS',
    earned: 110,
    attainable: 110,
    components: [
      { code: 'AMOUNT_EXACT', dimension: 'AMOUNT', passed: true, weight: 50 },
      { code: 'COMPETING_CANDIDATE', dimension: 'UNIQUENESS', passed: false },
    ],
  };

  it('shows a high score alongside the band that overrides it', () => {
    // A perfect score that is still ambiguous: the band has to be visible, or
    // a reader would take the 100 at face value.
    render(
      <>
        <ConfidenceMeter confidence={ambiguous} />
        <StatusChip status={ambiguous.band} />
      </>,
    );

    expect(screen.getByText('100')).toBeDefined();
    expect(screen.getByText('Ambiguo')).toBeDefined();
  });

  it('renders failed checks as failures, not as omissions', () => {
    render(<EvidenceList confidence={ambiguous} />);

    expect(screen.getByText(/otro depósito igualmente compatible/)).toBeDefined();
  });

  it('shows the raw score against what was attainable', () => {
    render(<ConfidenceMeter confidence={ambiguous} />);
    expect(screen.getByText(/110 de 110 puntos alcanzables/)).toBeDefined();
  });

  it('marks a check that could not be run as neither passed nor failed', () => {
    // The distinction the score depends on: Wompi publishing no breakdown is
    // not the same as a breakdown that failed to balance, and a red cross
    // told people something had gone wrong when nothing had.
    render(
      <EvidenceList
        confidence={{
          ...ambiguous,
          components: [
            {
              code: 'IDENTITY_BROKEN',
              dimension: 'INTEGRITY',
              passed: false,
              applicable: false,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('no aplica')).toBeDefined();
    expect(screen.queryByText('✗')).toBeNull();
  });

  it('says out loud when a gate disqualified the candidate', () => {
    render(
      <EvidenceList
        confidence={{ ...ambiguous, band: 'UNMATCHED', disqualifiedBy: 'AMOUNT_MISMATCH' }}
      />,
    );

    expect(screen.getByText(/Descalificada por/)).toBeDefined();
  });
});

describe('StatusChip', () => {
  it('never styles an ambiguous match as a success', () => {
    const { container } = render(<StatusChip status="AMBIGUOUS" />);
    expect(container.querySelector('.chip--confirmed')).toBeNull();
    expect(container.querySelector('.chip--ambiguous')).not.toBeNull();
  });

  it('translates ERP statuses too, since the vocabulary is shared', () => {
    render(<StatusChip status="INCOMPLETE_ENTRY" />);
    expect(screen.getByText('Asiento incompleto')).toBeDefined();
  });
});

describe('ProposedEntryTable (F05-T05)', () => {
  const entry: ProposedEntryDto = {
    ref: 'mov:mov_a1b2c3d4e5f60718',
    journalId: 48,
    date: '2026-04-24',
    reason: 'INCOMPLETE_ENTRY',
    writable: true,
    missingConcepts: ['FEE', 'TAX', 'WITHHOLDING'],
    lines: [
      { accountCode: '1110001', accountName: 'Wompi Tarjetas', debit: money(30_342_952), credit: money(0), label: 'Neto' },
      { accountCode: '530505', accountName: 'Gastos Bancarios', debit: money(786_240), credit: money(0), label: 'Comisión' },
      { accountCode: '240810', accountName: 'IVA Descontable', debit: money(149_385), credit: money(0), label: 'IVA' },
      { accountCode: '236500', accountName: 'Retención', debit: money(476_323), credit: money(0), label: 'Retención' },
      { accountCode: '420500', accountName: 'Otras Ventas', debit: money(0), credit: money(31_754_900), label: 'Venta' },
    ],
  };

  it('shows the proposal as a balanced double entry', () => {
    render(<ProposedEntryTable entry={entry} journalKey="wompi" />);
    expect(screen.getByText('Cuadra')).toBeDefined();
  });

  it('names the concepts the existing entry omits', () => {
    render(<ProposedEntryTable entry={entry} journalKey="wompi" />);
    expect(screen.getByText(/FEE, TAX, WITHHOLDING/)).toBeDefined();
  });

  it('refuses to offer the write when the entry does not balance', () => {
    // Odoo lo rechazaría igual, pero un botón que se puede apretar y siempre
    // falla enseña a la gente a ignorar los errores.
    const roto: ProposedEntryDto = {
      ...entry,
      lines: [{ ...entry.lines[0]!, debit: money(1) }, ...entry.lines.slice(1)],
    };

    render(<ProposedEntryTable entry={roto} journalKey="wompi" />);
    expect(screen.getByText('No cuadra')).toBeDefined();
    expect(screen.getByRole('button', { name: /Crear asiento/ }).hasAttribute('disabled')).toBe(true);
  });

  it('las líneas que le faltan a un asiento existente se muestran, sin botón', () => {
    // Agregarle líneas a un asiento contabilizado es decisión de un contador:
    // la corrección se ve, pero no se ofrece escribirla.
    render(
      <MemoryRouter>
        <ProposedEntryTable entry={{ ...entry, writable: false }} journalKey="wompi" />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: /Crear asiento/ })).toBeNull();
    expect(screen.getByText('sólo para mostrar')).toBeDefined();
  });

  it('cuando el asiento ya existe ofrece deshacerlo, no volver a crearlo', () => {
    // La marca no vive en este componente: llega del ERP. Por eso sobrevive a
    // recargar la pantalla y desaparece sola si alguien borra el asiento.
    render(
      <MemoryRouter>
        <ProposedEntryTable
          entry={entry}
          journalKey="wompi"
          written={{
            ref: entry.ref,
            entryId: '1554',
            name: '(borrador sin numerar)',
            state: 'draft',
            date: '2026-02-25',
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Creado en borrador')).toBeDefined();
    expect(screen.getByRole('button', { name: /Deshacer/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Crear asiento/ })).toBeNull();
  });

  it('contabilizado deja de ser nuestro: ni se borra ni se vuelve a crear', () => {
    render(
      <MemoryRouter>
        <ProposedEntryTable
          entry={entry}
          journalKey="wompi"
          written={{
            ref: entry.ref,
            entryId: '1554',
            name: 'BNK8/2026/00041',
            state: 'posted',
            date: '2026-02-25',
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Contabilizado/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Deshacer/ })).toBeNull();
    expect(screen.getByText(/Restablecer a borrador/)).toBeDefined();
  });
});

describe('states (F05-T04)', () => {
  it('says what it is loading, not just that it is loading', () => {
    render(<Loading what="las liquidaciones" />);
    expect(screen.getByText(/las liquidaciones/)).toBeDefined();
  });

  it('gives a failure an actionable hint', () => {
    render(<Failed message="La API no respondió." hint="Ejecutá `make demo`." />);
    expect(screen.getByText(/make demo/)).toBeDefined();
  });

  it('confirms an empty result rather than showing a blank page', () => {
    render(<Empty title="Todo cerró">Las 40 liquidaciones conciliaron.</Empty>);
    expect(screen.getByText('Todo cerró')).toBeDefined();
  });

  it('warns when a source did not answer, instead of passing stale data off as fresh', () => {
    const health: HealthDto = {
      status: 'degraded',
      version: '0.1.0',
      rulesetVersion: 'v1',
      sources: [
        { id: 'odoo:journal-48', mode: 'live', state: 'stale', asOf: '2026-09-18T10:00:00.000Z' },
      ],
    };

    render(<SourceBanner health={health} />);
    expect(screen.getByText(/no respondió/)).toBeDefined();
    expect(screen.getByText(/2026-09-18/)).toBeDefined();
  });

  it('shows nothing at all when every source is healthy', () => {
    const health: HealthDto = {
      status: 'ok',
      version: '0.1.0',
      rulesetVersion: 'v1',
      sources: [{ id: 'wompi:transactions', mode: 'live', state: 'ready' }],
    };

    const { container } = render(<SourceBanner health={health} />);
    expect(container.firstChild).toBeNull();
  });
});
