// Types for the parts of backfill.mjs that packages/eval/test/backfill.test.ts runs against the real schema.
export interface Query {
  sql: string;
  params: Array<string | number>;
}
export const DEFAULT_RATE: number;
export const PENDING_WINDOW_MS: number;
export function missingQuery(
  opts: { predictor: string; consented: boolean; mimics: string[]; retryFailed: boolean },
  now?: number,
): Query;
export function statsQuery(predictor: string): Query;
export function errorsQuery(predictor: string): Query;
