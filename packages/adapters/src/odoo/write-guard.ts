import type { AccountMap, ErpEntry } from '@aa/core';
import type { JournalEntryDraft } from './journal-entry-builder.js';

/**
 * Everything that has to be true before a single row is written into Odoo.
 *
 * This instance is a company's production accounting. Two journals were handed
 * to us as a sandbox and nothing else is ours to touch, so the guard is not a
 * validation — it is the thing that makes a mistake in the rest of the system
 * unable to reach anything that matters.
 *
 * The allowlist is not a separate list somebody maintains: it is derived from
 * the chart of accounts we were given. A journal that is not in
 * `config/odoo-accounts.json` cannot be written to, because there is nowhere
 * for its id to come from. Same for account codes. Adding a book to the
 * blast radius means editing that file, in a commit, where someone sees it.
 *
 * Four more conditions, each closing a different way to cause damage:
 *
 *   - the flag. `ODOO_WRITE_ENABLED` is false by default, so the accident of
 *     running the wrong command writes nothing.
 *   - the reference prefix. Every entry we create is keyed `mov:<movementId>`,
 *     which is what lets deletion be certain it is removing something we made.
 *   - draft only. A draft is reversible; a posted entry is not.
 *   - it has to balance. Odoo would refuse anyway, but failing here names the
 *     malformed correction instead of surfacing a JSON-RPC fault.
 */

export const REF_PREFIX = 'mov:';

export class WriteRefused extends Error {
  constructor(
    readonly reason: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = 'WriteRefused';
  }
}

export interface WritePolicy {
  readonly enabled: boolean;
  readonly allowedJournalIds: readonly number[];
  readonly allowedAccountCodes: readonly string[];
}

/** The blast radius, read off the chart we were handed. */
export function policyFrom(accountMap: AccountMap, enabled: boolean): WritePolicy {
  return {
    enabled,
    allowedJournalIds: accountMap.journalIds,
    allowedAccountCodes: accountMap.accountCodes,
  };
}

export function assertCreatable(draft: JournalEntryDraft, policy: WritePolicy): void {
  if (!policy.enabled) {
    throw new WriteRefused(
      'La escritura en Odoo está deshabilitada. Poné ODOO_WRITE_ENABLED=true para habilitarla.',
    );
  }
  if (!draft.ref.startsWith(REF_PREFIX)) {
    throw new WriteRefused('Un asiento creado por este sistema tiene que llevar su referencia', {
      ref: draft.ref,
    });
  }
  if (!policy.allowedJournalIds.includes(draft.journalId)) {
    throw new WriteRefused(
      `El diario ${draft.journalId} no está en el plan de cuentas que nos dieron`,
      { journalId: draft.journalId, permitidos: policy.allowedJournalIds },
    );
  }

  const ajenas = draft.lines
    .map((line) => line.accountCode)
    .filter((code) => !policy.allowedAccountCodes.includes(code));
  if (ajenas.length > 0) {
    throw new WriteRefused('El asiento toca cuentas fuera del plan que nos dieron', {
      cuentas: ajenas,
      permitidas: policy.allowedAccountCodes,
    });
  }

  if (draft.lines.length === 0) {
    throw new WriteRefused('Un asiento sin líneas no corrige nada', { ref: draft.ref });
  }

  const negativas = draft.lines.filter(
    (line) => line.debit.cents < 0 || line.credit.cents < 0,
  );
  if (negativas.length > 0) {
    throw new WriteRefused('Un asiento no lleva importes negativos: el signo elige el lado', {
      ref: draft.ref,
      cuentas: negativas.map((line) => line.accountCode),
    });
  }

  const debits = draft.lines.reduce((total, line) => total + line.debit.cents, 0);
  const credits = draft.lines.reduce((total, line) => total + line.credit.cents, 0);
  if (debits !== credits) {
    throw new WriteRefused('El asiento no cuadra', { ref: draft.ref, debits, credits });
  }
}

/**
 * Deleting is narrower than creating on purpose.
 *
 * Only a draft, only in an allowed journal, only carrying our own reference.
 * Anything an accountant touched has either been posted or has lost the
 * reference, and in both cases this refuses.
 */
export function assertDeletable(entry: ErpEntry, policy: WritePolicy): void {
  if (!policy.enabled) {
    throw new WriteRefused(
      'La escritura en Odoo está deshabilitada. Poné ODOO_WRITE_ENABLED=true para habilitarla.',
    );
  }
  if (!entry.ref?.startsWith(REF_PREFIX)) {
    throw new WriteRefused('Ese asiento no lo creó este sistema, así que no lo borra', {
      name: entry.name,
      ref: entry.ref ?? null,
    });
  }
  if (!policy.allowedJournalIds.includes(entry.journalId)) {
    throw new WriteRefused(`El diario ${entry.journalId} no es uno de los nuestros`, {
      journalId: entry.journalId,
      permitidos: policy.allowedJournalIds,
    });
  }
  if (entry.state !== 'draft') {
    throw new WriteRefused(
      `El asiento está en estado ${entry.state}; sólo se borra un borrador`,
      { name: entry.name, state: entry.state },
    );
  }
}
