import type { AccountId } from './ids.js';
import type { Currency } from './money.js';

/**
 * GATEWAY: a payment processor holding money on our behalf (Wompi).
 * BANK:    a commercial bank account (Bancolombia).
 * ERP:     a formal accounting book in Odoo, ingested like any other source.
 */
export type AccountKind = 'GATEWAY' | 'BANK' | 'ERP';

export interface Account {
  readonly id: AccountId;
  readonly kind: AccountKind;
  readonly name: string;
  readonly currency: Currency;
  /** Bank account number, journal id, or whatever identifies it externally. */
  readonly externalRef?: string;
}
