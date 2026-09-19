import { z } from 'zod';

/**
 * The published vocabulary every conclusion is explained with.
 *
 * It lives in `contracts` because it is part of the wire: the API serves it at
 * `GET /evidence-codes`, the frontend renders a sentence per code, and an AI
 * consumer cites codes rather than inventing categories.
 *
 * `core` keeps its own copy as a plain union, because the domain cannot depend
 * on zod and must not be shaped by the wire format. The two are kept in step
 * by a test in `apps/api`, which is the one place that legitimately imports
 * both — so drift is a build failure, not a surprise in production. This is
 * the same trade made for DTOs against entities. See ADR-0010.
 */
export const EvidenceCodeDto = z.enum([
  // —— Phase 2: channel to bank
  'AMOUNT_EXACT',
  'AMOUNT_WITHIN_ROUNDING',
  'IMPLIED_FEE_IN_BAND',
  'AMOUNT_MISMATCH',
  'DATE_T1_EXACT',
  'DATE_IN_WINDOW',
  'DATE_OUT_OF_WINDOW',
  'DESCRIPTOR_MATCH',
  'DESCRIPTOR_FOREIGN',
  'UNIQUE_CANDIDATE',
  'COMPETING_CANDIDATE',
  'IDENTITY_HOLDS',
  'IDENTITY_BROKEN',
  'SETTLEMENT_SINGLE_CREDIT',
  'SETTLEMENT_SPLIT',
  'SUBSET_SUM_UNIQUE',
  'SUBSET_SUM_MULTIPLE',
  'UNRESOLVED_COMBINATORIAL',

  // —— Phase 3: ledger to ERP
  'MATCHED_BY_REF',
  'MATCHED_EXACT',
  'MATCHED_AGGREGATED',
  'INCOMPLETE_ENTRY',
  'DATE_SHIFT',
  'AMOUNT_MISMATCH_ERP',
  'MISSING_IN_ERP',
  'MISSING_IN_LEDGER',
  'DUPLICATE_IN_ERP',
  'NO_ACCOUNT_MAPPING',

  // —— Phase 1: ingestion
  'BALANCE_CHAIN_OK',
  'BALANCE_CHAIN_BROKEN',
  'SUMMARY_TOTALS_OK',
  'SUMMARY_TOTALS_MISMATCH',
  'TRANSACTION_EXCLUDED_NOT_APPROVED',
  'DESCRIPTOR_UNCLASSIFIED',
  'SOURCE_STALE',
  'DEDUCTIONS_DERIVED',
]);

export type EvidenceCode = z.infer<typeof EvidenceCodeDto>;

/** Every code, for exhaustive rendering and for the drift test. */
export const EVIDENCE_CODES: readonly EvidenceCode[] = EvidenceCodeDto.options;

export type EvidenceDimension =
  | 'AMOUNT'
  | 'DATE'
  | 'DESCRIPTOR'
  | 'UNIQUENESS'
  | 'INTEGRITY'
  | 'ERP'
  | 'INGESTION';

/**
 * Which question each code answers.
 *
 * Declared rather than derived from the code's spelling: inferring a dimension
 * from a prefix works until someone adds a code that does not fit the pattern,
 * and then it is wrong silently. `Record<EvidenceCode, …>` makes a new code
 * fail to compile until it is classified.
 */
export const EVIDENCE_DIMENSIONS: Readonly<Record<EvidenceCode, EvidenceDimension>> = {
  AMOUNT_EXACT: 'AMOUNT',
  AMOUNT_WITHIN_ROUNDING: 'AMOUNT',
  IMPLIED_FEE_IN_BAND: 'AMOUNT',
  AMOUNT_MISMATCH: 'AMOUNT',
  SETTLEMENT_SINGLE_CREDIT: 'INTEGRITY',
  SETTLEMENT_SPLIT: 'INTEGRITY',
  SUBSET_SUM_UNIQUE: 'AMOUNT',
  SUBSET_SUM_MULTIPLE: 'AMOUNT',
  UNRESOLVED_COMBINATORIAL: 'AMOUNT',
  DATE_T1_EXACT: 'DATE',
  DATE_IN_WINDOW: 'DATE',
  DATE_OUT_OF_WINDOW: 'DATE',
  DESCRIPTOR_MATCH: 'DESCRIPTOR',
  DESCRIPTOR_FOREIGN: 'DESCRIPTOR',
  UNIQUE_CANDIDATE: 'UNIQUENESS',
  COMPETING_CANDIDATE: 'UNIQUENESS',
  IDENTITY_HOLDS: 'INTEGRITY',
  IDENTITY_BROKEN: 'INTEGRITY',
  MATCHED_BY_REF: 'ERP',
  MATCHED_EXACT: 'ERP',
  MATCHED_AGGREGATED: 'ERP',
  INCOMPLETE_ENTRY: 'ERP',
  DATE_SHIFT: 'ERP',
  AMOUNT_MISMATCH_ERP: 'ERP',
  MISSING_IN_ERP: 'ERP',
  MISSING_IN_LEDGER: 'ERP',
  DUPLICATE_IN_ERP: 'ERP',
  NO_ACCOUNT_MAPPING: 'ERP',
  BALANCE_CHAIN_OK: 'INGESTION',
  BALANCE_CHAIN_BROKEN: 'INGESTION',
  SUMMARY_TOTALS_OK: 'INGESTION',
  SUMMARY_TOTALS_MISMATCH: 'INGESTION',
  TRANSACTION_EXCLUDED_NOT_APPROVED: 'INGESTION',
  DESCRIPTOR_UNCLASSIFIED: 'INGESTION',
  SOURCE_STALE: 'INGESTION',
  DEDUCTIONS_DERIVED: 'AMOUNT',
};
