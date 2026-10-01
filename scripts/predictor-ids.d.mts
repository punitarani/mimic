// Types for predictor-ids.mjs, which packages/eval/test/relabel-predictors.test.ts checks against packages/core.
export const DECISION_PREFIX: string;
export const LEGACY_DECISION_PREFIX: string;
export const JEV_MODEL: string;
export const DECISION_MODELS: Record<string, string>;
export function canonicalPredictorId(id: string): string;
export function predictorIdSpellings(id: string): string[];
