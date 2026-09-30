import { z } from 'zod';
import { parsePredictorId } from './config';
import { normalizeDist, optionKeys } from './distribution';
import type { CallContext, Gateway } from './gateway';
import { answerToDistribution, confidenceOf, predictionQuestion } from './jev';
import { PROMPTS } from './prompts';
import { renderStateText, stateForProvider } from './state-builder';
import type { DecisionQuestion, PersonState, PredictionResult, Predictor, Question } from './types';

/** Jev key for a question inside a batched request. */
export function jevKey(q: Pick<Question, 'id'>): string {
  return `q_${q.id}`;
}

/** Primary / baseline predictor: one batched Jev request per shared state (PLAN §5.1). */
export class JevPredictor implements Predictor {
  readonly id: string;
  constructor(
    private readonly gateway: Gateway,
    private readonly model: string,
    private readonly ctx: CallContext,
  ) {
    this.id = `jev:${model}`;
  }

  async predict(state: PersonState, qs: Question[]): Promise<PredictionResult[]> {
    if (qs.length === 0) return [];
    const questions: Record<string, DecisionQuestion> = {};
    for (const q of qs) questions[jevKey(q)] = predictionQuestion(q);
    try {
      const res = await this.gateway.decide(this.ctx, {
        model: this.model,
        state: stateForProvider(state),
        questions,
      });
      const share = res.usage.costUsd / qs.length;
      return qs.map((q) => {
        const a = res.answers[jevKey(q)];
        if (!a) return failed(`missing answer for ${jevKey(q)}`, res.latencyMs, res.modelSnapshot, share);
        try {
          const out: PredictionResult = {
            dist: answerToDistribution(q, a),
            costUsd: share,
            latencyMs: res.latencyMs,
            modelSnapshot: res.modelSnapshot,
            ok: true,
          };
          const c = confidenceOf(a);
          if (c !== undefined) out.confidence = c;
          return out;
        } catch (e) {
          return failed(String(e), res.latencyMs, res.modelSnapshot, share);
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return qs.map(() => failed(msg, 0, this.model, 0));
    }
  }
}

const LlmProbs = z.union([
  z.object({ probs: z.array(z.object({ key: z.string(), p: z.number() })) }),
  z.record(z.string(), z.number()),
]);

export const LLM_PREDICTOR_MAX_TOKENS = 3000;

/** LLM shadow predictor (PLAN §9.6, prompt predict.v1). One chat call per question, run in parallel. */
export class LlmPredictor implements Predictor {
  readonly id: string;
  constructor(
    private readonly gateway: Gateway,
    private readonly model: string,
    private readonly ctx: CallContext,
  ) {
    this.id = `llm:${model}`;
  }

  predict(state: PersonState, qs: Question[]): Promise<PredictionResult[]> {
    const stateText = renderStateText(state);
    return Promise.all(qs.map((q) => this.one(stateText, q)));
  }

  private async one(stateText: string, q: Question): Promise<PredictionResult> {
    const p = PROMPTS['predict.v1'];
    const keys = optionKeys(q);
    try {
      const res = await this.gateway.chat(this.ctx, {
        model: this.model,
        messages: [
          { role: 'system', content: p.system },
          {
            role: 'user',
            content: `STATE:\n${stateText}\n\nQUESTION: ${q.prompt}\nOPTIONS:\n${q.options
              .map((o) => `${o.key}: ${o.label}`)
              .join('\n')}`,
          },
        ],
        jsonSchema: { name: 'probs', schema: p.schema },
        reasoningEffort: 'low',
        maxTokens: LLM_PREDICTOR_MAX_TOKENS,
      });
      const base = { costUsd: res.usage.costUsd, latencyMs: res.latencyMs, modelSnapshot: res.modelSnapshot };
      const parsed = LlmProbs.safeParse(parseJsonLoose(res.content));
      if (!parsed.success) return { ...base, dist: {}, ok: false, error: 'invalid JSON output' };
      const raw: Record<string, number> =
        'probs' in parsed.data && Array.isArray(parsed.data.probs)
          ? Object.fromEntries(parsed.data.probs.map((x) => [x.key, x.p]))
          : (parsed.data as Record<string, number>);
      const covered = keys.filter((k) => typeof raw[k] === 'number' && raw[k]! >= 0);
      const sum = covered.reduce((a, k) => a + raw[k]!, 0);
      if (covered.length < keys.length || !(sum > 0)) {
        return { ...base, dist: {}, ok: false, error: 'output does not cover every option' };
      }
      return { ...base, dist: normalizeDist(raw, keys), ok: true };
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e), 0, this.model, 0);
    }
  }
}

function failed(error: string, latencyMs: number, modelSnapshot: string, costUsd: number): PredictionResult {
  return { dist: {}, costUsd, latencyMs, modelSnapshot, ok: false, error };
}

/** Parses JSON from model output, tolerating code fences and surrounding prose. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1]);
      } catch {}
    }
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {}
    }
    return undefined;
  }
}

export function makePredictor(gateway: Gateway, id: string, ctx: CallContext): Predictor {
  const spec = parsePredictorId(id);
  return spec.kind === 'jev'
    ? new JevPredictor(gateway, spec.model, ctx)
    : new LlmPredictor(gateway, spec.model, ctx);
}
