import { z } from 'zod';
import { canonicalJson, sha256Hex } from './hash';

export const PipelineConfig = z.object({
  version: z.literal(1),
  ontologyVersion: z.string(),
  anchors: z.object({ setId: z.string(), count: z.number().int() }),
  generator: z.object({
    model: z.string(),
    reasoningEffort: z.enum(['none', 'low', 'medium']),
    promptVersion: z.string(),
    batchSize: z.number().int(),
    domainMix: z.object({ core: z.number(), casual: z.number(), professional: z.number() }),
  }),
  selector: z.discriminatedUnion('type', [
    z.object({ type: z.literal('random') }),
    z.object({ type: z.literal('coverage') }),
    z.object({ type: z.literal('entropy'), lambdaCoverage: z.number(), muRedundancy: z.number() }),
    z.object({ type: z.literal('bald'), k: z.number().int(), lambdaCoverage: z.number() }),
  ]),
  predictor: z.object({ primary: z.string(), shadows: z.array(z.string()) }),
  stateBuilder: z.object({
    strategy: z.enum(['raw', 'structured', 'summary', 'full']),
    budgetTokens: z.number().int(),
    retrievalK: z.number().int(),
    recentN: z.number().int(),
  }),
  traitReader: z.object({ type: z.enum(['jev', 'none']), everyN: z.number().int() }),
  reflector: z.object({
    model: z.string().nullable(),
    everyN: z.number().int(),
    promptVersion: z.string(),
    requireCitations: z.literal(true),
  }),
  repeats: z.object({ every: z.number().int(), minGap: z.number().int() }),
  reveal: z.enum(['after_answer', 'never']),
  session: z.object({ target: z.number().int(), budgetUsd: z.number() }),
  /** ADR-0005: the embedding model is part of the config because it drives dedupe and retrieval. */
  embedding: z.object({ model: z.string() }),
});
export type PipelineConfig = z.infer<typeof PipelineConfig>;

export const JEV_MODEL = 'typesafe/jev-1.13';
export const LLM = {
  luna: 'openai/gpt-6-luna',
  deepseek: 'deepseek/deepseek-v4.1-flash',
  glm: 'z-ai/glm-5.3-flash',
  mimoFlash: 'xiaomi/mimo-v2.6-flash',
  qwenFlash: 'qwen/qwen3.8-flash',
} as const;
export const EMBEDDING_MODEL = 'baai/bge-base-en-v1.5';

/**
 * `cfg.default.v3`: the v1 shadows plus MiMo V2.6 Flash and Qwen3.8 Flash (ADR-0025). v2 added MiMo V2.6 Pro
 * (ADR-0024); v3 drops it, since Flash-tier models cost a fraction as much. Configs are immutable, so older mimics keep
 * the config they were created with; `pnpm backfill` adds new shadows to their served questions. Deviation
 * (ADR-0004): generator and reflector default to DeepSeek V4.1 Flash, not GPT-6 Luna.
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  version: 1,
  ontologyVersion: 'v1',
  anchors: { setId: 'anchors.v1', count: 10 },
  generator: {
    model: LLM.deepseek,
    reasoningEffort: 'low',
    promptVersion: 'gen.v1',
    batchSize: 12,
    domainMix: { core: 0.1, casual: 0.45, professional: 0.45 },
  },
  selector: { type: 'entropy', lambdaCoverage: 0.3, muRedundancy: 0.5 },
  predictor: {
    primary: `jev:${JEV_MODEL}`,
    shadows: [
      `llm:${LLM.luna}`,
      `llm:${LLM.deepseek}`,
      `llm:${LLM.glm}`,
      `llm:${LLM.mimoFlash}`,
      `llm:${LLM.qwenFlash}`,
    ],
  },
  stateBuilder: { strategy: 'full', budgetTokens: 8000, retrievalK: 12, recentN: 6 },
  traitReader: { type: 'jev', everyN: 1 },
  reflector: { model: LLM.deepseek, everyN: 5, promptVersion: 'reflect.v1', requireCitations: true },
  repeats: { every: 8, minGap: 6 },
  reveal: 'after_answer',
  session: { target: 30, budgetUsd: 0.5 },
  embedding: { model: EMBEDDING_MODEL },
};
export const DEFAULT_CONFIG_LABEL = 'cfg.default.v3';

export function configHash(config: PipelineConfig): string {
  return sha256Hex(canonicalJson(PipelineConfig.parse(config)));
}

export type PredictorSpec = { kind: 'jev'; model: string } | { kind: 'llm'; model: string };

export function parsePredictorId(id: string): PredictorSpec {
  const idx = id.indexOf(':');
  const kind = id.slice(0, idx);
  const model = id.slice(idx + 1);
  if (idx < 0 || !model) throw new Error(`Invalid predictor id: ${id}`);
  if (kind === 'jev' || kind === 'llm') return { kind, model };
  throw new Error(`Unknown predictor kind: ${id}`);
}
