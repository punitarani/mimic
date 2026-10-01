import type {
  ChatRequest,
  ChatResponse,
  DecisionAnswer,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  Embedder,
  EmbedResult,
  LlmClient,
} from '@mimic/core';
import { z } from 'zod';
import { authHeader, HttpError, type HttpOptions, requestJson } from './http';

export const OPENROUTER_BASE = 'https://openrouter.ai';

export interface OpenRouterOptions extends HttpOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Per-model provider order preferences, e.g. { 'deepseek/deepseek-v4.1-flash': ['wafer'] }. */
  providerOrder?: Record<string, string[]>;
  appName?: string;
}

/** Defaults: DeepSeek V4.1 Flash via Wafer when available (fast, honors json_schema), falling back to others. */
export const DEFAULT_PROVIDER_ORDER: Record<string, string[]> = {
  'deepseek/deepseek-v4.1-flash': ['wafer'],
};

const Usage = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cost: z.number().optional(),
  })
  .passthrough();

const ChatResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string(),
    provider: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable().optional() }).passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: Usage.optional(),
  })
  .passthrough();

/**
 * OpenRouter can answer 200 with an error body instead of a completion (the provider failed after the response
 * started, e.g. "Provider returned an empty response").
 */
const ErrorBody = z.object({
  error: z.object({ message: z.string().optional(), code: z.union([z.number(), z.string()]).optional() }),
});

/** OpenRouter chat completions: JSON schema, reasoning effort, cost from `usage.cost`. Never sends temperature. */
export class OpenRouterChat implements LlmClient {
  readonly provider = 'openrouter';
  constructor(private readonly opts: OpenRouterOptions = {}) {}

  buildBody(req: ChatRequest): Record<string, unknown> {
    const order = (this.opts.providerOrder ?? DEFAULT_PROVIDER_ORDER)[req.model];
    const provider: Record<string, unknown> = {};
    if (req.jsonSchema) provider.require_parameters = true;
    if (order?.length) {
      provider.order = order;
      provider.allow_fallbacks = true;
    }
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      usage: { include: true },
    };
    if (Object.keys(provider).length) body.provider = provider;
    if (req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
      };
    }
    // A budget and an effort are alternatives on OpenRouter; a budget is the only control some models honour.
    if (req.reasoningMaxTokens !== undefined)
      body.reasoning = { max_tokens: req.reasoningMaxTokens, exclude: true };
    else if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort, exclude: true };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    return body;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.opts.baseUrl ?? OPENROUTER_BASE}/api/v1/chat/completions`;
    const { json, latencyMs, attempts } = await requestJson(
      { timeoutMs: 90_000, retryTimeouts: false, ...this.opts },
      url,
      {
        headers: {
          ...authHeader('authorization', this.opts.apiKey, 'Bearer '),
          'x-title': this.opts.appName ?? 'Mimic',
        },
        body: this.buildBody(req),
      },
    );
    const failed = ErrorBody.safeParse(json);
    if (failed.success && !(json as { choices?: unknown }).choices) {
      const { code, message } = failed.data.error;
      // A numeric code is an HTTP status; anything else is the provider failing mid-response (retryable).
      throw new HttpError(typeof code === 'number' ? code : 502, message ?? JSON.stringify(json), url);
    }
    const r = ChatResponseSchema.parse(json);
    const usage = r.usage ?? {};
    const choice = r.choices[0]!;
    // The provider failed mid-generation: a failed call, not the model's answer.
    if (choice.finish_reason === 'error') {
      const detail = (choice as { error?: { message?: string } }).error?.message;
      throw new HttpError(502, detail ?? 'the provider stopped with finish_reason "error"', url);
    }
    return {
      content: choice.message.content ?? '',
      // OpenRouter does not return dated chat snapshots; the serving provider matters (quantization), so record it.
      modelSnapshot: r.provider ? `${r.model}@${r.provider}` : r.model,
      ...(r.provider ? { provider: r.provider } : {}),
      ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
      usage: {
        inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
        costUsd: usage.cost ?? 0,
      },
      latencyMs,
      attempts,
      raw: json,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Jev via the Decisions API (PLAN §5.1). Tolerant of schema drift: unknown fields pass through.
// ---------------------------------------------------------------------------------------------------------------

const Probs = z.record(z.string(), z.number());
const JevAnswer = z.union([
  z.object({ type: z.literal('noul'), noul: z.number() }).passthrough(),
  z
    .object({
      type: z.literal('choice'),
      choice: z.string(),
      confidence: z.number().optional(),
      probabilities: Probs,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('score'),
      score: z.number(),
      confidence: z.number().optional(),
      probabilities: Probs,
      // Never read: the level is the probability's key. Clef and Perplexity's decider allow any JSON per level.
      legend: z.unknown().optional(),
    })
    .passthrough(),
]);

export const JevResponse = z
  .object({
    model: z.string(),
    answers: z.record(z.string(), JevAnswer),
    usage: z
      .object({ input_tokens: z.number(), output_tokens: z.number(), cost: z.number().optional() })
      .passthrough(),
    id: z.string().optional(),
    provider: z.string().optional(),
  })
  .passthrough();

export function toDecisionAnswer(a: z.infer<typeof JevAnswer>): DecisionAnswer {
  switch (a.type) {
    case 'noul':
      return { type: 'noul', p: a.noul };
    case 'choice': {
      const out: DecisionAnswer = { type: 'choice', choice: a.choice, probabilities: a.probabilities };
      if (a.confidence !== undefined) out.confidence = a.confidence;
      return out;
    }
    case 'score': {
      const out: DecisionAnswer = { type: 'score', score: a.score, probabilities: a.probabilities };
      if (a.confidence !== undefined) out.confidence = a.confidence;
      return out;
    }
  }
}

export class JevDecisions implements DecisionProvider {
  readonly provider = 'openrouter-decisions';
  constructor(private readonly opts: OpenRouterOptions = {}) {}

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const { json, latencyMs, attempts } = await requestJson(
      { timeoutMs: 15_000, ...this.opts },
      `${this.opts.baseUrl ?? OPENROUTER_BASE}/api/alpha/decisions`,
      {
        headers: {
          ...authHeader('authorization', this.opts.apiKey, 'Bearer '),
          'x-title': this.opts.appName ?? 'Mimic',
        },
        body: { model: req.model, state: req.state, questions: req.questions },
      },
    );
    const r = JevResponse.parse(json);
    return {
      modelSnapshot: r.model,
      answers: Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, toDecisionAnswer(a)])),
      usage: {
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
        costUsd: r.usage.cost ?? 0,
      },
      latencyMs,
      attempts,
      raw: json,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Embeddings via OpenRouter (local dev and the CLI; Workers AI serves the same model in deployed envs).
// ---------------------------------------------------------------------------------------------------------------

const EmbeddingResponse = z
  .object({
    model: z.string().optional(),
    data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().optional() }).passthrough()),
    usage: Usage.optional(),
  })
  .passthrough();

export class OpenRouterEmbedder implements Embedder {
  readonly provider = 'openrouter';
  constructor(
    readonly model: string,
    private readonly opts: OpenRouterOptions = {},
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    const { json, latencyMs, attempts } = await requestJson(
      { timeoutMs: 20_000, ...this.opts },
      `${this.opts.baseUrl ?? OPENROUTER_BASE}/api/v1/embeddings`,
      {
        headers: authHeader('authorization', this.opts.apiKey, 'Bearer '),
        body: { model: this.model, input: texts },
      },
    );
    const r = EmbeddingResponse.parse(json);
    const sorted = [...r.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      vectors: sorted.map((d) => d.embedding),
      model: this.model,
      usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: 0, costUsd: r.usage?.cost ?? 0 },
      latencyMs,
      attempts,
    };
  }
}
