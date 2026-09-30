import {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_LABEL,
  DEFAULT_CONFIG_V3,
  type EngineDeps,
  type PipelineConfig,
  registerConfig,
} from '@mimic/core';

/**
 * The M10 candidate (ADR-0042): the default config (cfg.default.v7 since ADR-0048) on ontology v2 with reserve.v2,
 * gen.v3, gates.v3, reflect.v2 and an everyday-first domain mix. An eval config only: cfg.default.v8 (ADR-0044) adds
 * the selector's category balance and trust ramp on top of it.
 */
export const M10_CANDIDATE_CONFIG: PipelineConfig = {
  ...DEFAULT_CONFIG,
  ontologyVersion: 'v2',
  reserve: { setId: 'reserve.v2' },
  generator: {
    ...DEFAULT_CONFIG.generator,
    promptVersion: 'gen.v3',
    gates: 'gates.v3',
    domainMix: { core: 0.15, casual: 0.55, professional: 0.3 },
  },
  reflector: { ...DEFAULT_CONFIG.reflector, promptVersion: 'reflect.v2' },
};

/** Configs the eval CLI can run a session under, by name (`--config`). */
export const NAMED_CONFIGS: Record<string, { config: PipelineConfig; label: string }> = {
  default: { config: DEFAULT_CONFIG, label: DEFAULT_CONFIG_LABEL },
  v3: { config: DEFAULT_CONFIG_V3, label: 'cfg.default.v3' },
  'm10-candidate': { config: M10_CANDIDATE_CONFIG, label: 'cfg.m10.candidate' },
};

/** Registers a named config (idempotent) and returns its hash. */
export async function registerNamedConfig(deps: EngineDeps, name: string): Promise<string> {
  const c = NAMED_CONFIGS[name];
  if (!c) throw new Error(`Unknown config "${name}"; known: ${Object.keys(NAMED_CONFIGS).join(', ')}`);
  return registerConfig(deps, c.config, c.label);
}
