import type {
  AccountDto,
  CorrelationDto,
  LineageDto,
  MovementDto,
  SettlementBatchDto,
} from '@aa/contracts';
import type { Account, Correlation, Lineage, Movement, SettlementBatch } from '@aa/core';
import { toMoneyDto } from './money.presenter.js';
import { toEvidenceDto } from './reconciliation.presenter.js';

/**
 * Domain to DTO, written out by hand.
 *
 * Some of these look almost like a copy of the entity, and that is the point:
 * the mapping is what lets the internal model change without breaking the
 * published contract, and the other way round. It is the dull price of the
 * boundary in ADR-0010, paid explicitly and in one place.
 */

export function toAccountDto(account: Account): AccountDto {
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    currency: account.currency,
    ...(account.externalRef ? { externalRef: account.externalRef } : {}),
  };
}

export function toMovementDto(movement: Movement): MovementDto {
  return {
    id: movement.id,
    accountId: movement.accountId,
    ...(movement.externalId ? { externalId: movement.externalId } : {}),
    occurredAt: movement.occurredAt.toString(),
    valueDate: movement.valueDate.toString(),
    type: movement.type,
    amount: toMoneyDto(movement.amount),
    ...(movement.counterparty ? { counterparty: movement.counterparty } : {}),
    description: movement.description,
    source: {
      sourceId: movement.source.sourceId,
      rawRecordId: movement.source.rawRecordId,
      ...(movement.source.locator ? { locator: movement.source.locator } : {}),
    },
  };
}

export function toSettlementBatchDto(batch: SettlementBatch): SettlementBatchDto {
  return {
    id: batch.id,
    accountId: batch.accountId,
    batchDate: batch.batchDate.toString(),
    chargeIds: [...batch.chargeIds],
    gross: toMoneyDto(batch.gross),
    deductions: batch.deductions.map((deduction) => ({
      kind: deduction.kind,
      amount: toMoneyDto(deduction.amount),
      basis: deduction.basis,
      movementIds: [...deduction.movementIds],
    })),
    expectedNet: toMoneyDto(batch.expectedNet),
  };
}

export function toLineageDto(lineage: Lineage): LineageDto {
  return {
    movementId: lineage.movementId,
    gross: toMoneyDto(lineage.gross),
    attributedNet: toMoneyDto(lineage.attributedNet),
    batchId: lineage.batchId,
    ...(lineage.matchId ? { matchId: lineage.matchId } : {}),
    ...(lineage.bankCreditId ? { bankCreditId: lineage.bankCreditId } : {}),
    settled: lineage.settled,
    steps: lineage.steps.map((step) => ({
      stage: step.stage,
      ref: step.ref,
      date: step.date.toString(),
      amount: toMoneyDto(step.amount),
      detail: step.detail,
    })),
  };
}

export function toCorrelationDto(correlation: Correlation): CorrelationDto {
  return {
    verdict: correlation.verdict,
    channelMovementId: correlation.channelMovementId,
    bankMovementId: correlation.bankMovementId,
    ...(correlation.batchId ? { batchId: correlation.batchId } : {}),
    ...(correlation.matchId ? { matchId: correlation.matchId } : {}),
    ...(correlation.attributedNet ? { attributedNet: toMoneyDto(correlation.attributedNet) } : {}),
    ...(correlation.shareOfBatch !== undefined ? { shareOfBatch: correlation.shareOfBatch } : {}),
    evidence: correlation.evidence.map(toEvidenceDto),
  };
}
