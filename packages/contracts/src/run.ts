import { z } from 'zod';
import { EvidenceCodeDto } from './evidence-codes.js';
import { EvidenceDimensionDto, IsoDate, IsoInstant, MoneyDto } from './primitives.js';
import { ReconciliationSummaryDto } from './reconciliation.js';

/**
 * A run is immutable: runs are not overwritten, they are compared. That is
 * what lets the system answer "why did it say something different yesterday?",
 * and it is why the inputs are hashed rather than merely named.
 */
export const RunDto = z.object({
  id: z.string(),
  startedAt: IsoInstant,
  finishedAt: IsoInstant.optional(),
  rulesetVersion: z.string(),
  range: z.object({ from: IsoDate, to: IsoDate }),
  inputHashes: z
    .record(z.string(), z.string())
    .describe('sha256 per source document, so a result can be tied to exact inputs'),
});

export const CreateRunDto = z.object({
  from: IsoDate,
  to: IsoDate,
  sources: z.array(z.string()).optional(),
});

/** The funnel: what was expected, what arrived, and what is unexplained. */
export const RunSummaryDto = z.object({
  run: RunDto,
  funnel: z.object({
    grossSales: MoneyDto,
    fees: MoneyDto,
    taxes: MoneyDto,
    withholdings: MoneyDto,
    expectedNet: MoneyDto,
    credited: MoneyDto,
    difference: MoneyDto,
  }),
  flow: ReconciliationSummaryDto,
  erp: z.object({
    byStatus: z.record(z.string(), z.number().int()),
    unexplained: MoneyDto,
  }),
});

/** RFC 9457. Every error leaves the API in this shape, no exceptions. */
export const ProblemDto = z.object({
  type: z.string().describe('URI identifying the problem type'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional().describe('The domain error code, for programmatic handling'),
});

/** One entry of the vocabulary listing, as served by GET /evidence-codes. */
export const EvidenceCodeInfoDto = z.object({
  code: EvidenceCodeDto,
  dimension: EvidenceDimensionDto,
  weight: z.number().optional(),
  meaning: z.string(),
});

export const HealthDto = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  rulesetVersion: z.string(),
  sources: z.array(
    z.object({
      id: z.string(),
      mode: z.enum(['fixtures', 'live']),
      state: z.enum(['ready', 'stale', 'unavailable']),
      asOf: IsoInstant.optional(),
    }),
  ),
});

export type RunDto = z.infer<typeof RunDto>;
export type RunSummaryDto = z.infer<typeof RunSummaryDto>;
export type ProblemDto = z.infer<typeof ProblemDto>;
export type HealthDto = z.infer<typeof HealthDto>;

/** A bank statement waiting in the inbox for the next run. */
export const StatementFileDto = z.object({
  name: z.string(),
  bytes: z.number().int(),
  receivedAt: z.string(),
});

/**
 * An upload, base64 in a JSON body.
 *
 * Multipart would be the conventional choice and would cost a dependency and
 * a second parsing path. A monthly statement is under a megabyte, so the
 * simpler shape carries it, and the browser already has the bytes.
 */
export const UploadStatementDto = z.object({
  filename: z.string().min(1).max(200),
  contentBase64: z.string().min(1),
});

export type StatementFileDto = z.infer<typeof StatementFileDto>;
export type UploadStatementDto = z.infer<typeof UploadStatementDto>;
