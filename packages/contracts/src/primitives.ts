import { z } from 'zod';
import { EvidenceCodeDto, type EvidenceDimension } from './evidence-codes.js';

/**
 * The shared vocabulary every DTO is built from.
 *
 * These schemas are the single definition the whole contract derives from:
 * request and response validation in the API, JSON Schema for an AI consumer,
 * OpenAPI for the docs, and types for the frontend. Defining them once is the
 * main reason the backend and the frontend share a language. See ADR-0007.
 */

/**
 * Money on the wire.
 *
 * `cents` is the truth and the only thing anyone should compute with;
 * `formatted` is there so the frontend never reimplements formatting and
 * cannot drift from what the printed report says.
 */
export const MoneyDto = z
  .object({
    cents: z.number().int(),
    currency: z.literal('COP'),
    formatted: z.string(),
  })
  .describe('An amount in minor units, plus its display form in es-AR');

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Calendar date in the business timezone (America/Bogota)');

export const IsoInstant = z.string().datetime().describe('RFC 3339 timestamp in UTC');

export const EvidenceDimensionDto = z.enum([
  'AMOUNT',
  'DATE',
  'DESCRIPTOR',
  'UNIQUENESS',
  'INTEGRITY',
  'ERP',
  'INGESTION',
]) satisfies z.ZodType<EvidenceDimension>;

/**
 * One check, with what it expected and what it found.
 *
 * A conclusion never travels without these: the score is a sum of them, and a
 * consumer that cannot see the components cannot argue with the number.
 */
export const EvidenceDto = z.object({
  code: EvidenceCodeDto.describe('The vocabulary is closed; see GET /evidence-codes'),
  dimension: EvidenceDimensionDto,
  passed: z.boolean(),
  applicable: z
    .boolean()
    .optional()
    .describe('False when the check could not be run at all, as opposed to run and failed'),
  weight: z.number().optional(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  detail: z.string().optional(),
  locator: z.string().optional().describe('Where in the source document this was observed'),
});

export const ConfidenceDto = z.object({
  score: z.number().int().min(0).max(100).describe('Normalised over the attainable maximum'),
  disqualifiedBy: EvidenceCodeDto.optional().describe(
    'A gate that failed. Forces UNMATCHED whatever the score',
  ),
  band: z.enum(['CONFIRMED', 'PROBABLE', 'AMBIGUOUS', 'UNMATCHED']),
  earned: z.number(),
  attainable: z.number(),
  components: z.array(EvidenceDto),
});

/**
 * Where a value came from, down to the row of the original document.
 *
 * This is what lets any figure in a report be traced back to a byte someone
 * can open, which is the difference between an explanation and an assertion.
 */
export const SourceRefDto = z.object({
  sourceId: z.string(),
  rawRecordId: z.string(),
  locator: z.string().optional(),
});

/** Cursor pagination: ledgers are long and grow, and offsets drift. */
export const PageDto = z.object({
  nextCursor: z.string().nullable(),
  count: z.number().int(),
});

export type MoneyDto = z.infer<typeof MoneyDto>;
export type EvidenceDto = z.infer<typeof EvidenceDto>;
export type ConfidenceDto = z.infer<typeof ConfidenceDto>;
export type SourceRefDto = z.infer<typeof SourceRefDto>;
export type PageDto = z.infer<typeof PageDto>;
