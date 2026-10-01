import {
  DEFAULT_CONFIG_V8,
  DEFAULT_CONFIG_V8_LABEL,
  E3B_CONTROL_CONFIG,
  E3B_CONTROL_LABEL,
  E7_PROBES_CONFIG,
  E7_PROBES_LABEL,
  type PipelineConfig,
} from '../config';
import type { ExperimentRecord } from '../store';
import { type EngineDeps, EngineError, registerConfig } from './deps';

export interface ExperimentPreset {
  name: string;
  /** What the experiment tests, shown next to the button in `/lab`. */
  summary: string;
  arms: Array<{ arm: string; config: PipelineConfig; label: string; weight: number }>;
}

/**
 * Experiments ready to set up from `/lab` (ADR-0045). A preset registers its configs and saves a draft; starting it
 * stays a person's decision, made in `/lab`.
 */
export const EXPERIMENT_PRESETS = {
  e3b: {
    name: 'E3b: category balance (M12) vs v4 selection',
    summary:
      'cfg.default.v8 against the same config with the selection it had before M12 (cfg.e3b.control), 1:1. Measures questions to sustain fidelity 0.75 and fidelity at 20, on real people; about 64 people per arm to detect a three-question difference.',
    arms: [
      { arm: 'control', config: E3B_CONTROL_CONFIG, label: E3B_CONTROL_LABEL, weight: 1 },
      { arm: 'v8', config: DEFAULT_CONFIG_V8, label: DEFAULT_CONFIG_V8_LABEL, weight: 1 },
    ],
  },
  e7: {
    name: 'E7: held-out probes',
    summary:
      'cfg.default.v10 with fourteen probes per person at fixed points (cfg.e7.probes): three items asked of everyone, two repeats, and the rest at a measured distance from what the person answered. Measures what the mimic learns per distance, apart from what selection asks next; read with pnpm eval -- probes. Decides when E3b can start.',
    arms: [{ arm: 'probes', config: E7_PROBES_CONFIG, label: E7_PROBES_LABEL, weight: 1 }],
  },
} as const satisfies Record<string, ExperimentPreset>;
export type PresetId = keyof typeof EXPERIMENT_PRESETS;

export function isPresetId(id: string): id is PresetId {
  return Object.hasOwn(EXPERIMENT_PRESETS, id);
}

/**
 * Registers a preset's configs and saves it as a draft experiment. Idempotent by name: a second call returns the
 * experiment already saved, whatever its status, and never starts, stops or changes it.
 */
export async function setupPreset(
  deps: EngineDeps,
  id: string,
): Promise<{ experiment: ExperimentRecord; created: boolean }> {
  if (!isPresetId(id)) throw new EngineError('not_found', `Unknown experiment preset "${id}"`);
  const preset: ExperimentPreset = EXPERIMENT_PRESETS[id];
  const arms: ExperimentRecord['arms'] = [];
  for (const a of preset.arms)
    arms.push({ arm: a.arm, configHash: await registerConfig(deps, a.config, a.label), weight: a.weight });
  const existing = (await deps.store.listExperiments()).find((e) => e.name === preset.name);
  if (existing) return { experiment: existing, created: false };
  const experiment: ExperimentRecord = {
    id: deps.newId(),
    name: preset.name,
    status: 'draft',
    arms,
    createdAt: deps.clock(),
  };
  await deps.store.putExperiment(experiment);
  return { experiment, created: true };
}
