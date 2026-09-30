import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHALLENGER_PURPOSES,
  DECISION_MODELS,
  DEFAULT_BUDGET_USD,
  DEFAULT_SESSION_SHARE,
  decisionModelOf,
  FLAG_KEYS,
  JEV_MODEL,
} from '@mimic/core';
import { describe, expect, it } from 'vitest';

interface Flag {
  key: string;
  enabled: boolean;
  default_variation: string;
  variations: Record<string, unknown>;
  rules: unknown[];
}

describe('flag catalog (ADR-0050)', () => {
  it('deploy creates every flag the code reads, with the code’s defaults', async () => {
    const url = pathToFileURL(join(__dirname, '../../../scripts/deploy/flags.mjs')).href;
    const { flagCatalog } = (await import(url)) as { flagCatalog: (source?: object) => Flag[] };
    const catalog = flagCatalog();
    expect(catalog.map((f) => f.key).sort()).toEqual(Object.values(FLAG_KEYS).sort());
    const defaults = Object.fromEntries(catalog.map((f) => [f.key, f.variations[f.default_variation]]));
    expect(decisionModelOf(String(defaults[FLAG_KEYS.decisionsModel]))).toBe(JEV_MODEL);
    expect(defaults).toEqual({
      [FLAG_KEYS.decisionsModel]: 'jev',
      [FLAG_KEYS.decisionsModelPurposes]: CHALLENGER_PURPOSES.join(','),
      [FLAG_KEYS.budgetUsd]: DEFAULT_BUDGET_USD,
      [FLAG_KEYS.budgetSessionShare]: DEFAULT_SESSION_SHARE,
      // Without settings; deploy seeds these from the environment's resolved vars.
      [FLAG_KEYS.searchProvider]: 'exa',
      [FLAG_KEYS.enrichProvider]: 'exa',
      [FLAG_KEYS.embeddingsProvider]: 'workers-ai',
    });
    // Every variant deploy creates names a model the code knows.
    const variants = catalog.find((f) => f.key === FLAG_KEYS.decisionsModel)!.variations;
    expect(Object.values(variants).sort()).toEqual(Object.keys(DECISION_MODELS).sort());
    // Enabled with no rules: every evaluation serves the default variation (a disabled flag would too, but explicitly).
    for (const f of catalog) expect([f.enabled, f.rules]).toEqual([true, []]);
  });
});
