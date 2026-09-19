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

export const ReconciliationSummaryDto = z.object({
  batches: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  expectedNet: MoneyDto,
  observedNet: MoneyDto,
  unexplained: MoneyDto,
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
export type UnattributedCreditDto = z.infer<typeof UnattributedCreditDto>;
