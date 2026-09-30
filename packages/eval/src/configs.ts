import {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_LABEL,
  DEFAULT_CONFIG_V3,
  DEFAULT_CONFIG_V6,
  type EngineDeps,
  type PipelineConfig,
  registerConfig,
} from '@mimic/core';

/**
 * The M10 candidate (ADR-0042): cfg.default.v6 on ontology v2 with reserve.v2, gen.v3, gates.v3, reflect.v2 and an
 * everyday-first domain mix. An eval config only: cfg.default.v7 (ADR-0044) is this with the selector's category
 * balance and trust ramp, so comparing the two isolates the selector.
 */
export const M10_CANDIDATE_CONFIG: PipelineConfig = {
  ...DEFAULT_CONFIG_V6,
  ontologyVersion: 'v2',
  reserve: { setId: 'reserve.v2' },
  generator: {
    ...DEFAULT_CONFIG_V6.generator,
    promptVersion: 'gen.v3',
    gates: 'gates.v3',
    domainMix: { core: 0.15, casual: 0.55, professional: 0.3 },
  },
  reflector: { ...DEFAULT_CONFIG_V6.reflector, promptVersion: 'reflect.v2' },
};

/** Configs the eval CLI can run a session under, by name (`--config`). */
export const NAMED_CONFIGS: Record<string, { config: PipelineConfig; label: string }> = {
  default: { config: DEFAULT_CONFIG, label: DEFAULT_CONFIG_LABEL },
  v3: { config: DEFAULT_CONFIG_V3, label: 'cfg.default.v3' },
  v6: { config: DEFAULT_CONFIG_V6, label: 'cfg.default.v6' },
  'm10-candidate': { config: M10_CANDIDATE_CONFIG, label: 'cfg.m10.candidate' },
};

/** Registers a named config (idempotent) and returns its hash. */
export async function registerNamedConfig(deps: EngineDeps, name: string): Promise<string> {
  const c = NAMED_CONFIGS[name];
  if (!c) throw new Error(`Unknown config "${name}"; known: ${Object.keys(NAMED_CONFIGS).join(', ')}`);
  return registerConfig(deps, c.config, c.label);
}
