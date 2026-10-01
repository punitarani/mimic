// Types for relabel-predictors.mjs, which packages/eval/test/relabel-predictors.test.ts runs against the real schema.
import type { Query, Target } from './backfill.mjs';

export const DEFAULT_BATCH: number;
export const MAX_BATCH: number;
export const SERVED_ROLES: string[];
export const CHALLENGERS: Array<[variant: string, model: string]>;
export interface RelabelOptions {
  env: string;
  batch: number;
  reverse: boolean;
  yes: boolean;
}
export function parseRelabelArgs(argv: string[]): RelabelOptions;
export function countQuery(reverse: boolean): Query;
export function twinCountQuery(): Query;
export function twinDeleteQueries(): Query[];
export function rewriteQuery(reverse: boolean, batch: number): Query;
export function servedCountQuery(challenger: string, prefixes?: string[]): Query;
export function servedRewriteQuery(challenger: string, batch: number): Query;
export function snapshotsQuery(): Query;
export function legacyJobsQuery(prefix?: string): Query;
export function relabel(
  opts: RelabelOptions,
  target: Pick<Target, 'name' | 'query'>,
  deps?: { log?: (line: string) => void },
): Promise<{ legacy: number; twins: number; served: number; rewritten: number }>;
