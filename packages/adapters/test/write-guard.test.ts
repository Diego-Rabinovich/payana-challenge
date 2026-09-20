import { describe, expect, it } from 'vitest';
import { AccountMap, Money } from '@aa/core';
import type { ErpEntry } from '@aa/core';
import { Temporal } from '@js-temporal/polyfill';
import {
  REF_PREFIX,
  WriteRefused,
  assertCreatable,
  assertDeletable,
  policyFrom,
} from '../src/odoo/write-guard.js';
import type { JournalEntryDraft } from '../src/odoo/journal-entry-builder.js';

/**
 * The Odoo instance behind this is a company's production accounting. Two
 * journals were handed over as a sandbox; everything else belongs to people
 * who did not agree to be part of a challenge.
 *
 * These are the tests that make that true rather than intended.
 */

const CHART = AccountMap.from({
  journals: {
    wompi: { id: 48, name: 'Wompi Tarjetas', mainAccount: '1110001', suspenseAccount: '1010001' },
    bancolombia: { id: 49, name: 'Bancolombia', mainAccount: '111001', suspenseAccount: '111002' },
  },
  accounts: {
    CHARGE: { code: '420500', name: 'Otras Ventas' },
    FEE: { code: '530505', name: 'Gastos Bancarios' },
  },
});

const ON = policyFrom(CHART, true);
const OFF = policyFrom(CHART, false);

function draft(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    ref: `${REF_PREFIX}mov_0123456789abcdef`,
    journalId: 48,
    date: '2026-01-20',
    lines: [
      {
        accountCode: '1110001',
        accountName: 'Wompi Tarjetas',
        debit: Money.ofCents(1000),
        credit: Money.zero(),
        label: 'Neto',
      },
      {
        accountCode: '420500',
        accountName: 'Otras Ventas',
        debit: Money.zero(),
        credit: Money.ofCents(1000),
        label: 'Venta',
      },
    ],
    ...overrides,
  };
}

describe('el alcance sale del plan de cuentas, no de una lista aparte', () => {
  it('los diarios permitidos son exactamente los que nos dieron', () => {
    expect([...ON.allowedJournalIds].sort()).toEqual([48, 49]);
  });

  it('las cuentas permitidas incluyen las del plan y las de los diarios', () => {
    expect([...ON.allowedAccountCodes].sort()).toEqual(
      ['1010001', '111001', '111002', '1110001', '420500', '530505'].sort(),
    );
  });
});

describe('crear', () => {
  it('con la bandera apagada no escribe nada', () => {
    expect(() => assertCreatable(draft(), OFF)).toThrow(WriteRefused);
    expect(() => assertCreatable(draft(), OFF)).toThrow(/deshabilitada/);
  });

  it('acepta un asiento que cuadra, en un diario nuestro, con cuentas nuestras', () => {
    expect(() => assertCreatable(draft(), ON)).not.toThrow();
  });

  it('rechaza cualquier diario que no nos dieron', () => {
    // El caso que importa: 1 es el diario de ventas de la empresa real.
    for (const journalId of [1, 2, 47, 50, 999]) {
      expect(() => assertCreatable(draft({ journalId }), ON)).toThrow(/no está en el plan/);
    }
  });

  it('rechaza una cuenta fuera del plan aunque el diario sea nuestro', () => {
    const conCuentaAjena = draft({
      lines: [
        { ...draft().lines[0]!, accountCode: '999999' },
        draft().lines[1]!,
      ],
    });
    expect(() => assertCreatable(conCuentaAjena, ON)).toThrow(/fuera del plan/);
  });

  it('rechaza un asiento sin nuestra referencia', () => {
    expect(() => assertCreatable(draft({ ref: 'ajuste manual' }), ON)).toThrow(/referencia/);
  });

  it('rechaza un asiento que no cuadra', () => {
    const roto = draft({
      lines: [{ ...draft().lines[0]!, debit: Money.ofCents(999) }, draft().lines[1]!],
    });
    expect(() => assertCreatable(roto, ON)).toThrow(/no cuadra/);
  });

  it('rechaza un asiento sin líneas', () => {
    expect(() => assertCreatable(draft({ lines: [] }), ON)).toThrow(/sin líneas/);
  });
});

describe('borrar, que es más estrecho que crear', () => {
  const entry = (overrides: Partial<ErpEntry> = {}): ErpEntry => ({
    id: '1234',
    journalId: 48,
    name: 'WMP/2026/00099',
    ref: `${REF_PREFIX}mov_0123456789abcdef`,
    date: Temporal.PlainDate.from('2026-01-20'),
    state: 'draft',
    lines: [],
    ...overrides,
  });

  it('borra un borrador nuestro en un diario nuestro', () => {
    expect(() => assertDeletable(entry(), ON)).not.toThrow();
  });

  it('no borra algo que ya fue contabilizado', () => {
    expect(() => assertDeletable(entry({ state: 'posted' }), ON)).toThrow(/borrador/);
    expect(() => assertDeletable(entry({ state: 'cancel' }), ON)).toThrow(/borrador/);
  });

  it('no borra un asiento que no creamos nosotros', () => {
    expect(() => assertDeletable(entry({ ref: 'FAC-2026-001' }), ON)).toThrow(/no lo creó/);
    const sinRef = { ...entry() } as { ref?: string };
    delete sinRef.ref;
    expect(() => assertDeletable(sinRef as ErpEntry, ON)).toThrow(/no lo creó/);
  });

  it('no borra fuera de nuestros diarios', () => {
    expect(() => assertDeletable(entry({ journalId: 1 }), ON)).toThrow(/no es uno de los nuestros/);
  });

  it('con la bandera apagada no borra nada', () => {
    expect(() => assertDeletable(entry(), OFF)).toThrow(/deshabilitada/);
  });
});

describe('un asiento en borrador todavia no tiene nombre', () => {
  it('lo dice en vez de propagar el false que devuelve Odoo', async () => {
    // Odoo no asigna numero de secuencia hasta contabilizar y responde `false`.
    // Ese booleano llegaba a la evidencia y tiraba la pantalla del ERP entera
    // con "text.replace is not a function", apenas creamos el primer borrador.
    const { OdooErpGateway } = await import('../src/odoo/odoo-erp-gateway.js');
    const { OdooClient } = await import('../src/odoo/odoo-client.js');
    const { Temporal } = await import('@js-temporal/polyfill');

    const responses: unknown[] = [
      [
        {
          id: 1554,
          name: false,
          ref: 'mov:mov_14537891064d4a8b',
          date: '2026-02-25',
          state: 'draft',
          journal_id: [48, 'Wompi Tarjetas'],
        },
      ],
      [
        {
          id: 1,
          move_id: [1554, ''],
          account_id: [7, '1110001 Wompi Tarjetas'],
          name: 'Neto acreditado',
          debit: 1041.85,
          credit: 0,
        },
      ],
    ];

    const client = new OdooClient({
      url: 'http://odoo.test',
      database: 'db',
      userId: 1,
      apiKey: 'k',
      companyId: 2,
      fetch: (async () =>
        new Response(JSON.stringify({ result: responses.shift() }), {
          headers: { 'content-type': 'application/json' },
        })) as typeof globalThis.fetch,
    });

    const [entry] = await new OdooErpGateway(client, CHART).readJournal(48, {
      from: Temporal.PlainDate.from('2026-02-01'),
      to: Temporal.PlainDate.from('2026-02-28'),
    });

    expect(typeof entry!.name).toBe('string');
    expect(entry!.name).toBe('(borrador sin numerar)');
    expect(entry!.state).toBe('draft');
  });
});

describe('los asientos que dejamos escritos', () => {
  it('se los pregunta a Odoo, filtrando por diario y por nuestra referencia', async () => {
    // La consola tiene que poder decir "esto ya lo creaste" despues de
    // recargar. Anotarlo de nuestro lado seria una marca que sobrevive a que
    // alguien borre el asiento en Odoo, o sea una marca que miente.
    const { OdooErpGateway } = await import('../src/odoo/odoo-erp-gateway.js');
    const { OdooClient } = await import('../src/odoo/odoo-client.js');

    let dominio: unknown;
    const client = new OdooClient({
      url: 'http://odoo.test',
      database: 'db',
      userId: 1,
      apiKey: 'k',
      companyId: 2,
      fetch: (async (_url: unknown, init: { body: string }) => {
        dominio = JSON.parse(init.body).params.args[5][0];
        return new Response(
          JSON.stringify({
            result: [
              {
                id: 1554,
                name: false,
                ref: 'mov:mov_14537891064d4a8b',
                date: '2026-02-25',
                state: 'draft',
                journal_id: [48, 'Wompi Tarjetas'],
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });

    const written = await new OdooErpGateway(client, CHART).listOwnEntries(48);

    expect(dominio).toEqual([
      ['journal_id', '=', 48],
      ['ref', '=like', 'mov:%'],
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]!.ref).toBe('mov:mov_14537891064d4a8b');
    expect(written[0]!.state).toBe('draft');
    expect(written[0]!.name).toBe('(borrador sin numerar)');
    expect(written[0]!.date.toString()).toBe('2026-02-25');
  });
});
