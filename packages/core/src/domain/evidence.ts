/**
 * The closed vocabulary every conclusion in the system is explained with.
 *
 * Closed on purpose: it lets an AI cite `IMPLIED_FEE_IN_BAND` and have it mean
 * the same thing every time, and it lets the frontend render Spanish without
 * the backend generating prose.
 *
 * `@aa/contracts` publishes the same list as a zod enum, because the vocabulary
 * is part of the wire. The domain keeps this plain union rather than importing
 * it: `core` takes no dependency on zod and is not shaped by the wire format.
 * A test in `apps/api` asserts the two are identical, so drift breaks the
 * build. See ADR-0007 and ADR-0010.
 */
export const EVIDENCE_CODES = [
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
] as const;

export type EvidenceCode = (typeof EVIDENCE_CODES)[number];

export type EvidenceDimension =
  | 'AMOUNT'
  | 'DATE'
  | 'DESCRIPTOR'
  | 'UNIQUENESS'
  | 'INTEGRITY'
  | 'ERP'
  | 'INGESTION';

/**
 * One check, with what it expected and what it found. The score is a sum of
 * these; it never travels without them. See ADR-0005.
 */
export interface Evidence {
  readonly code: EvidenceCode;
  readonly dimension: EvidenceDimension;
  readonly passed: boolean;
  /** Contribution to the score, from the ruleset. Absent outside Phase 2. */
  readonly weight?: number;
  readonly expected?: string;
  readonly observed?: string;
  readonly detail?: string;
  /** Where in the source document this was observed, when applicable. */
  readonly locator?: string;
}

export function evidence(
  code: EvidenceCode,
  dimension: EvidenceDimension,
  passed: boolean,
  extra: Omit<Evidence, 'code' | 'dimension' | 'passed'> = {},
): Evidence {
  return { code, dimension, passed, ...extra };
}

const CODES = new Set<string>(EVIDENCE_CODES);

export function isEvidenceCode(value: string): value is EvidenceCode {
  return CODES.has(value);
}
