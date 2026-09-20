import { Temporal } from '@js-temporal/polyfill';
import { AccountMap, type AccountMapConfig } from '../domain/account-map.js';
import type { ErpEntry, ErpLine } from '../domain/erp-entry.js';
import { Money } from '../domain/money.js';

/** Mirrors config/odoo-accounts.json, so tests exercise the shipped chart. */
export const TEST_ACCOUNT_MAP_CONFIG: AccountMapConfig = {
  journals: {
    wompi: {
      id: 48,
      name: 'Wompi Tarjetas',
      mainAccount: '1110001',
      suspenseAccount: '1010001',
    },
    bancolombia: { id: 49, name: 'Bancolombia', mainAccount: '111001', suspenseAccount: '111002' },
  },
  accounts: {
    CHARGE: { code: '420500', name: 'Otras Ventas' },
    FEE: { code: '530505', name: 'Gastos Bancarios' },
    TAX: { code: '240810', name: 'IVA Descontable' },
    WITHHOLDING: { code: '236500', name: 'Retención En La Fuente' },
    TRANSFER_IN: { code: '111001', name: 'Banco' },
    TRANSFER_OUT: { code: '111001', name: 'Banco' },
  },
};

export function testAccountMap(overrides: Partial<AccountMapConfig> = {}): AccountMap {
  return AccountMap.from({ ...TEST_ACCOUNT_MAP_CONFIG, ...overrides });
}

export function erpLine(
  accountCode: string,
  debitCents: number,
  creditCents: number,
  label = '',
): ErpLine {
  return {
    id: `line-${accountCode}-${debitCents}-${creditCents}`,
    accountCode,
    accountName: accountCode,
    amount: Money.ofCents(debitCents - creditCents),
    label,
  };
}

export function erpEntry(input: {
  id: string;
  name: string;
  date: string;
  lines: ErpLine[];
  ref?: string;
  journalId?: number;
  state?: ErpEntry['state'];
}): ErpEntry {
  return {
    id: input.id,
    journalId: input.journalId ?? 48,
    name: input.name,
    ...(input.ref ? { ref: input.ref } : {}),
    date: Temporal.PlainDate.from(input.date),
    state: input.state ?? 'posted',
    lines: input.lines,
  };
}

/**
 * The two-line shape observed in the real journal: the gross amount debited to
 * the bank account and credited to sales, with no fee, VAT or withholding.
 */
export function twoLineGrossEntry(input: {
  id: string;
  name: string;
  date: string;
  grossCents: number;
  bankAccount?: string;
}): ErpEntry {
  const bank = input.bankAccount ?? '1110001';
  return erpEntry({
    id: input.id,
    name: input.name,
    date: input.date,
    lines: [
      erpLine(bank, input.grossCents, 0, 'Banco'),
      erpLine('420500', 0, input.grossCents, 'Otras Ventas'),
    ],
  });
}

/** The complete five-line shape a settled sale should produce. */
export function fiveLineEntry(input: {
  id: string;
  name: string;
  date: string;
  grossCents: number;
  feeCents: number;
  taxCents: number;
  withholdingCents: number;
  bankAccount?: string;
}): ErpEntry {
  const bank = input.bankAccount ?? '1110001';
  const net = input.grossCents - input.feeCents - input.taxCents - input.withholdingCents;
  return erpEntry({
    id: input.id,
    name: input.name,
    date: input.date,
    lines: [
      erpLine(bank, net, 0, 'Banco'),
      erpLine('530505', input.feeCents, 0, 'Gastos Bancarios'),
      erpLine('240810', input.taxCents, 0, 'IVA Descontable'),
      erpLine('236500', input.withholdingCents, 0, 'Retención En La Fuente'),
      erpLine('420500', 0, input.grossCents, 'Otras Ventas'),
    ],
  });
}
