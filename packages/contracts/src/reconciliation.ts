import { z } from 'zod';
import { ConfidenceDto, EvidenceDto, IsoDate, MoneyDto } from './primitives.js';
import { MovementTypeDto } from './ledger.js';

/**
 * Phase 2 on the wire. The shape is the brief's explainability checklist:
 * which movements it relates, which rule it used, which amount adjustment it
 * applied, which window it considered, how confident it is, and what it
 * discarded.
 */
export const ReconciliationDto = z.object({
  id: z.string(),
  runId: z.string().optional(),
  rulesetVersion: z.string().describe('Without this the result cannot be reproduced'),
  kind: z.literal('CHANNEL_TO_BANK'),
  status: z.enum(['CONFIRMED', 'PROBABLE', 'AMBIGUOUS', 'UNMATCHED', 'UNRESOLVED_COMBINATORIAL']),
  left: z.object({
    batchId: z.string(),
    batchDate: IsoDate,
    chargeIds: z.array(z.string()),
  }),
  right: z
    .object({ movementIds: z.array(z.string()).min(1) })
    .nullable()
    .describe('The credits that settled it. Several when the batch arrived split'),
  rule: z.object({ id: z.string(), version: z.number().int() }),
  amounts: z.object({
    gross: MoneyDto,
    deductions: MoneyDto,
    expectedNet: MoneyDto,
    observedNet: MoneyDto.optional(),
    delta: MoneyDto.optional(),
    impliedDeductionRate: z.number().optional(),
  }),
  window: z.object({ from: IsoDate, to: IsoDate, basis: z.literal('BUSINESS_DAYS') }),
  /**
   * The breakdown recovered from the gap when the gateway reported none.
   *
   * Kept apart from `amounts` on purpose: a reader has to be able to tell a
   * figure the source stated from one this system computed. See ADR-0013.
   */
  derivedDeductions: z
    .object({
      fee: MoneyDto,
      tax: MoneyDto,
      withholding: MoneyDto,
      total: MoneyDto,
      impliedRate: z.number(),
      consistent: z.boolean(),
    })
    .optional(),
  confidence: ConfidenceDto,
  alternatives: z.array(
    z.object({
      movementIds: z.array(z.string()),
      score: z.number(),
      rejectedBecause: z.string(),
    }),
  ),
});

/** A bank credit no batch claimed. Not an error — something the CFO must see. */
export const UnattributedCreditDto = z.object({
  movementId: z.string(),
  valueDate: IsoDate,
  amount: MoneyDto,
  counterparty: z.string().optional(),
  description: z.string(),
  reason: z.string(),
});

/**
 * The funnel, which is the first thing anyone reads.
 *
 * `deductionsAreDerived` is not decoration: a reader has to be able to tell a
 * commission the gateway stated from one this system inferred from the gap,
 * and the panel says so out loud rather than presenting both as the same
 * kind of number.
 */
export const ReconciliationSummaryDto = z.object({
  runId: z.string().optional(),
  rulesetVersion: z.string(),
  batches: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  gross: MoneyDto,
  deductions: MoneyDto,
  deductionsAreDerived: z.boolean(),
  expectedNet: MoneyDto,
  observedNet: MoneyDto,
  unexplained: MoneyDto,
  unattributed: z.object({
    channel: z.number().int().describe('Credits from the channel nobody claimed'),
    channelAmount: MoneyDto,
    other: z.number().int().describe('Credits from anyone else. Noise, kept visible'),
  }),
});

/**
 * One page of a finite collection.
 *
 * Offset rather than cursor, unlike the ledger: these collections are a run's
 * results, bounded and already in memory, and a reader needs to know there
 * are 56 of them. A cursor would hide the total, which is the number the
 * screen is actually about.
 */
export const OffsetPageDto = z.object({
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});

/** The correction a discrepancy implies, balanced and ready to post. */
export const ProposedEntryDto = z.object({
  ref: z.string().describe('Idempotency key: mov:<movementId>'),
  journalId: z.number().int(),
  date: IsoDate,
  reason: z.enum(['MISSING_ENTRY', 'INCOMPLETE_ENTRY']),
  missingConcepts: z.array(MovementTypeDto),
  lines: z.array(
    z.object({
      accountCode: z.string(),
      accountName: z.string(),
      debit: MoneyDto,
      credit: MoneyDto,
      label: z.string(),
    }),
  ),
});

/**
 * Un asiento que este sistema dejó escrito, tal como está hoy en el ERP.
 *
 * La consola lo usa para marcar en la tabla lo que ya se creó. Se consulta al
 * ERP en cada carga en vez de guardarlo de nuestro lado: una marca que
 * sobrevive a que alguien borre el asiento en Odoo miente.
 */
export const WrittenEntryDto = z.object({
  ref: z.string().describe('mov:<movementId>, la clave de idempotencia'),
  entryId: z.string(),
  name: z.string(),
  state: z.enum(['draft', 'posted', 'cancel']),
  date: IsoDate,
});

/** Phase 3 on the wire, one line per element of either side. */
export const ErpReconciliationLineDto = z.object({
  status: z.enum([
    'MATCHED',
    'INCOMPLETE_ENTRY',
    'AMOUNT_MISMATCH',
    'DATE_SHIFT',
    'MISSING_IN_ERP',
    'MISSING_IN_LEDGER',
    'DUPLICATE_IN_ERP',
  ]),
  matchLevel: z
    .enum(['REF', 'EXACT', 'AGGREGATED', 'APPROXIMATE', 'NONE'])
    .describe('Which criterion resolved it; an aggregated match is weaker than one by reference'),
  ledgerMovementIds: z.array(z.string()),
  erpEntryId: z.string().optional(),
  erpEntryName: z.string().optional(),
  erpEntryState: z
    .enum(['draft', 'posted', 'cancel'])
    .optional()
    .describe('Un borrador coincide pero todavia no esta en los libros'),
  descriptor: z.string().optional(),
  counterparty: z.string().optional(),
  date: IsoDate,
  ledgerAmount: MoneyDto.optional(),
  erpAmount: MoneyDto.optional(),
  delta: MoneyDto.optional(),
  evidence: z.array(EvidenceDto),
  proposedEntry: ProposedEntryDto.optional(),
});

export const ErpReconciliationDto = z.object({
  runId: z.string().optional(),
  journalId: z.number().int(),
  journalName: z.string(),
  lines: z.array(ErpReconciliationLineDto),
  totals: z.object({
    ledgerGroups: z.number().int(),
    erpEntries: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    ledgerTotal: MoneyDto,
    erpTotal: MoneyDto,
    unexplained: MoneyDto,
  }),
});

export type ReconciliationDto = z.infer<typeof ReconciliationDto>;
export type ErpReconciliationLineDto = z.infer<typeof ErpReconciliationLineDto>;
export type ErpReconciliationDto = z.infer<typeof ErpReconciliationDto>;
export type ProposedEntryDto = z.infer<typeof ProposedEntryDto>;
export type WrittenEntryDto = z.infer<typeof WrittenEntryDto>;
export type UnattributedCreditDto = z.infer<typeof UnattributedCreditDto>;
export type ReconciliationSummaryDto = z.infer<typeof ReconciliationSummaryDto>;
export type OffsetPageDto = z.infer<typeof OffsetPageDto>;
