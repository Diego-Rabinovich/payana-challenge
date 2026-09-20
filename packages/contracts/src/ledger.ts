import { z } from 'zod';
import { EvidenceDto, IsoDate, IsoInstant, MoneyDto, PageDto, SourceRefDto } from './primitives.js';

export const MovementTypeDto = z.enum([
  'CHARGE',
  'REFUND',
  'CHARGEBACK',
  'FEE',
  'TAX',
  'WITHHOLDING',
  'INTEREST',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'OTHER',
]);

export const AccountDto = z.object({
  id: z.string(),
  kind: z.enum(['GATEWAY', 'BANK', 'ERP']),
  name: z.string(),
  currency: z.literal('COP'),
  externalRef: z.string().optional(),
});

export const MovementDto = z.object({
  id: z.string(),
  accountId: z.string(),
  externalId: z.string().optional().describe('Shared by the parts of one sale'),
  occurredAt: IsoInstant,
  valueDate: IsoDate,
  type: MovementTypeDto,
  amount: MoneyDto.describe('Signed: inflows positive, outflows negative'),
  counterparty: z
    .string()
    .optional()
    .describe('As the source names it. A fact from the document, not a conclusion'),
  description: z.string(),
  source: SourceRefDto,
});

export const MovementPageDto = z.object({
  movements: z.array(MovementDto),
  page: PageDto,
});

export const DeductionDto = z.object({
  kind: z.enum(['FEE', 'TAX', 'WITHHOLDING']),
  amount: MoneyDto,
  basis: z.enum(['EXPLICIT', 'IMPLIED']).describe('Whether the source reported it or we inferred it'),
  movementIds: z.array(z.string()),
});

export const SettlementBatchDto = z.object({
  id: z.string(),
  accountId: z.string(),
  batchDate: IsoDate,
  chargeIds: z.array(z.string()),
  gross: MoneyDto,
  deductions: z.array(DeductionDto),
  expectedNet: MoneyDto,
});

/** The chain a single payment's money travelled, with every id resolvable. */
export const LineageDto = z.object({
  movementId: z.string(),
  gross: MoneyDto,
  attributedNet: MoneyDto.describe('This payment’s pro-rata share of the settlement'),
  batchId: z.string(),
  matchId: z.string().optional(),
  bankCreditId: z.string().optional(),
  settled: z.boolean(),
  steps: z.array(
    z.object({
      stage: z.enum(['CHARGE', 'BATCH', 'SETTLEMENT', 'BANK_CREDIT']),
      ref: z.string(),
      date: IsoDate,
      amount: MoneyDto,
      detail: z.string(),
    }),
  ),
});

export type MovementDto = z.infer<typeof MovementDto>;
export type AccountDto = z.infer<typeof AccountDto>;
export type SettlementBatchDto = z.infer<typeof SettlementBatchDto>;
export type LineageDto = z.infer<typeof LineageDto>;

/**
 * The brief's first primitive, on the wire: are these two movements related,
 * and why? The explanation is the underlying match's own evidence, unchanged.
 */
export const CorrelationDto = z.object({
  verdict: z.enum(['SETTLED_IN', 'SETTLED_ELSEWHERE', 'UNSETTLED', 'UNRELATED']),
  channelMovementId: z.string(),
  bankMovementId: z.string(),
  batchId: z.string().optional(),
  matchId: z.string().optional(),
  attributedNet: MoneyDto.optional(),
  shareOfBatch: z.number().optional(),
  evidence: z.array(EvidenceDto),
});

export type CorrelationDto = z.infer<typeof CorrelationDto>;
