/**
 * Branded ids. Nominal typing on top of strings, so a BatchId cannot be passed
 * where a MovementId is expected. Erased at runtime
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AccountId = Brand<string, 'AccountId'>;
export type MovementId = Brand<string, 'MovementId'>;
export type RawRecordId = Brand<string, 'RawRecordId'>;
export type BatchId = Brand<string, 'BatchId'>;
export type MatchId = Brand<string, 'MatchId'>;
export type RunId = Brand<string, 'RunId'>;
export type SourceId = Brand<string, 'SourceId'>;

export const accountId = (v: string): AccountId => v as AccountId;
export const movementId = (v: string): MovementId => v as MovementId;
export const rawRecordId = (v: string): RawRecordId => v as RawRecordId;
export const batchId = (v: string): BatchId => v as BatchId;
export const matchId = (v: string): MatchId => v as MatchId;
export const runId = (v: string): RunId => v as RunId;
export const sourceId = (v: string): SourceId => v as SourceId;
