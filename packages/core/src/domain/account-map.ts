import { ConfigurationError } from './errors.js';
import type { MovementType } from './movement.js';

/**
 * Canonical movement type to accounting code.
 *
 * The domain does not know the ERP's chart: it knows that a movement type may
 * or may not have an account, and that a type without one is reported rather
 * than quietly dropped. The codes themselves come from
 * config/odoo-accounts.json. See ADR-0002.
 */

export interface AccountRef {
  readonly code: string;
  readonly name: string;
}

export interface JournalRef {
  readonly id: number;
  readonly name: string;
  /** The account movements of this journal settle against. */
  readonly mainAccount: string;
  /** Odoo's suspense account: the bridge between two bank journals. */
  readonly suspenseAccount?: string;
}

export interface AccountMapConfig {
  readonly accounts: Readonly<Partial<Record<MovementType, AccountRef>>>;
  readonly journals: Readonly<Record<string, JournalRef>>;
}

export class AccountMap {
  private constructor(private readonly config: AccountMapConfig) {}

  static from(config: AccountMapConfig): AccountMap {
    if (Object.keys(config.journals).length === 0) {
      throw new ConfigurationError('Account map declares no journals', {});
    }
    return new AccountMap(config);
  }

  /** Undefined means "this concept has no account in the given chart". */
  accountFor(type: MovementType): AccountRef | undefined {
    return this.config.accounts[type];
  }

  requireAccount(type: MovementType): AccountRef {
    const account = this.accountFor(type);
    if (!account) {
      throw new ConfigurationError(`No account mapped for movement type ${type}`, { type });
    }
    return account;
  }

  journal(key: string): JournalRef | undefined {
    return this.config.journals[key];
  }

  journalById(id: number): JournalRef | undefined {
    return Object.values(this.config.journals).find((journal) => journal.id === id);
  }

  /** Types the chart does not cover, reported as NO_ACCOUNT_MAPPING. */
  isMapped(type: MovementType): boolean {
    return this.accountFor(type) !== undefined;
  }
}
