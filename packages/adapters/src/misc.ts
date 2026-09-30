import type { DecisionProvider, DecisionRequest, DecisionResponse, Embedder, EmbedResult } from '@mimic/core';

/** OpenAI Decisions API: interface stub only; out of scope for v1 (PLAN §1). */
export class OpenAiDecisionsStub implements DecisionProvider {
  readonly provider = 'openai-decisions';
  decide(_req: DecisionRequest): Promise<DecisionResponse> {
    return Promise.reject(new Error('OpenAI Decisions API is not implemented in v1'));
  }
}

interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

/** Workers AI embeddings (deployed envs). Same weights as the OpenRouter `baai/bge-base-en-v1.5` used locally. */
export class WorkersAiEmbedder implements Embedder {
  readonly provider = 'workers-ai';
  constructor(
    private readonly ai: AiBinding,
    readonly model: string,
  ) {}

  /** Our model ids are provider-neutral (`baai/bge-base-en-v1.5`); Workers AI prefixes them with `@cf/`. */
  static workersModelId(model: string): string {
    return model.startsWith('@cf/') ? model : `@cf/${model}`;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const started = Date.now();
    const out = (await this.ai.run(WorkersAiEmbedder.workersModelId(this.model), { text: texts })) as {
      data?: number[][];
    };
    if (!out?.data || out.data.length !== texts.length) throw new Error('Workers AI returned no embeddings');
    // Workers AI bills in neurons and returns no per-call cost; recorded as 0 (ADR-0005).
    return {
      vectors: out.data,
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Deterministic hashed bag-of-words embedder. Used only in tests and offline CLI runs, never for reported
 * metrics.
 */
export class HashEmbedder implements Embedder {
  readonly provider = 'local';
  constructor(
    readonly model = 'local/hash-256',
    private readonly dims = 256,
  ) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const tok of t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
        v[h % this.dims]! += 1;
      }
      const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / n);
    });
    return {
      vectors,
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: 0,
    };
  }
}
