// Types for the parts of backfill.mjs that packages/eval/test/backfill.test.ts runs against the real schema.
export interface Query {
  sql: string;
  params: string[];
}
export const DEFAULT_RATE: number;
export const MAX_JOBS: number;
export const MAX_DELAY_SECONDS: number;
export const PENDING_WINDOW_MS: number;
export const MAX_ATTEMPTS: number;
export const STALE_JOB_MS: number;
export function runLimit(rate: number): number;
export function missingQuery(
  opts: { predictor: string; consented: boolean; mimics: string[]; retryFailed: boolean },
  now?: number,
): Query;
export function statsQuery(predictor: string): Query;
export function errorsQuery(predictor: string): Query;
export function inFlightQuery(predictor: string, now?: number): Query;
