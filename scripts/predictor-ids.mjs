// Predictor ID spellings for the dependency-free scripts (`pnpm backfill`, `pnpm relabel:predictors`). Mirrors of
// packages/core/src/config.ts (ADR-0051, ADR-0052); packages/eval/test/relabel-predictors.test.ts checks them.

/** The decision kind's prefix: the OpenRouter Decisions API (Jev, span-01). */
export const DECISION_PREFIX = 'decision:';
/** Its name before ADR-0052. Hashed configs keep it, so it is read as `decision:` for ever. */
export const LEGACY_DECISION_PREFIX = 'jev:';
/** JEV_MODEL: the incumbent decision model. */
export const JEV_MODEL = 'typesafe/jev-1.13';
/** DECISION_MODELS: the `decisions-model` flag's variants and the pinned model each serves. */
export const DECISION_MODELS = { jev: JEV_MODEL, 'span-01': 'respan/span-01-20260925' };

/** A leading `jev:` becomes `decision:`; anything else is returned as it is. */
export function canonicalPredictorId(id) {
  return id.startsWith(LEGACY_DECISION_PREFIX)
    ? `${DECISION_PREFIX}${id.slice(LEGACY_DECISION_PREFIX.length)}`
    : id;
}

/** Every spelling a predictor may be stored under until the relabel has run, canonical first. */
export function predictorIdSpellings(id) {
  const canonical = canonicalPredictorId(id);
  return canonical.startsWith(DECISION_PREFIX)
    ? [canonical, `${LEGACY_DECISION_PREFIX}${canonical.slice(DECISION_PREFIX.length)}`]
    : [canonical];
}
