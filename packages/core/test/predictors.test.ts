import { describe, expect, it } from 'vitest';
import {
  type BudgetLedger,
  type ChatResponse,
  Gateway,
  isTransientError,
  LLM_PREDICTOR_MAX_TOKENS,
  LlmPredictor,
  type PersonState,
  type Question,
} from '../src';

const state: PersonState = {
  identity: { occupation: 'Teacher' },
  evidence: [],
  meta: { evidenceSeqMax: 0, stateHash: 'h', builder: 'raw', tokens: 10 },
};
const q: Question = {
  id: 'q1',
  mimicId: 'm1',
  seq: 1,
  kind: 'adaptive',
  type: 'choice',
  domain: 'casual',
  prompt: 'Coffee or tea?',
  options: [
    { key: 'a', label: 'Coffee' },
    { key: 'b', label: 'Tea' },
  ],
  facetIds: [],
  provenance: { generator: 'g', configHash: 'c', promptVersion: 'gen.v1' },
};

const reply = (over: Partial<ChatResponse>): ChatResponse => ({
  content: '{"probs":[{"key":"a","p":0.7},{"key":"b","p":0.3}]}',
  modelSnapshot: 'acme/m@P',
  usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.0002 },
  latencyMs: 1200,
  raw: {},
  ...over,
});

function predictor(chat: () => Promise<ChatResponse>, budget?: BudgetLedger) {
  const g = new Gateway({
    decisions: {
      provider: 'none',
      decide: () => Promise.reject(new Error('unused')),
    },
    llm: { provider: 'fake', chat },
    log: { write: async () => {} },
    ...(budget ? { budget } : {}),
    clock: () => 0,
    newId: () => 'id',
  });
  return new LlmPredictor(g, 'acme/m', { purpose: 'predict.shadow', mimicId: 'm1' });
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('LLM predictor failures (ADR-0037)', () => {
  it('returns a normalized distribution with the call latency and cost', async () => {
    const [r] = await predictor(async () => reply({})).predict(state, [q]);
    expect(r).toMatchObject({ ok: true, latencyMs: 1200, costUsd: 0.0002, dist: { a: 0.7, b: 0.3 } });
  });

  it('names a max_tokens cutoff or a content filter instead of calling it invalid JSON; all are the model failing', async () => {
    const [cut] = await predictor(async () =>
      reply({
        content: '',
        finishReason: 'length',
        usage: { inputTokens: 900, outputTokens: 3000, costUsd: 0.0015 },
      }),
    ).predict(state, [q]);
    expect(cut).toMatchObject({ ok: false, costUsd: 0.0015, latencyMs: 1200, errorKind: 'output' });
    expect(cut!.error).toBe(`output cut off at max_tokens (${LLM_PREDICTOR_MAX_TOKENS}; 3000 output tokens)`);
    expect(cut!.retryable).toBeUndefined();

    const [prose] = await predictor(async () =>
      reply({ content: 'Probably coffee.', finishReason: 'stop' }),
    ).predict(state, [q]);
    expect(prose).toMatchObject({ error: 'invalid JSON output', errorKind: 'output' });
    const [filtered] = await predictor(async () =>
      reply({ content: '', finishReason: 'content_filter' }),
    ).predict(state, [q]);
    expect(filtered).toMatchObject({ errorKind: 'output', error: expect.stringContaining('content filter') });
  });

  it('marks a failed call retryable when it may succeed later', async () => {
    const outcome = async (e: unknown) => (await predictor(() => Promise.reject(e)).predict(state, [q]))[0]!;
    expect(await outcome(httpError(429))).toMatchObject({
      ok: false,
      errorKind: 'transport',
      retryable: true,
      latencyMs: 0,
    });
    expect(await outcome(httpError(503))).toMatchObject({ errorKind: 'transport', retryable: true });
    expect(await outcome(new TypeError('fetch failed'))).toMatchObject({ retryable: true });
    expect(await outcome(httpError(400))).toMatchObject({
      ok: false,
      errorKind: 'transport',
      retryable: false,
    });
  });

  it('records a timeout as the model failing: too slow, and never retried', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const [r] = await predictor(() => Promise.reject(timeout)).predict(state, [q]);
    expect(r).toMatchObject({ ok: false, errorKind: 'timeout' });
    expect(r!.retryable).toBeUndefined();
    expect(isTransientError(timeout)).toBe(false);
  });

  it('does not retry the budget guard', async () => {
    const over: BudgetLedger = { get: async () => ({ spendUsd: 1, budgetUsd: 0.5 }), add: async () => {} };
    const [r] = await predictor(async () => reply({}), over).predict(state, [q]);
    expect(r).toMatchObject({ ok: false, errorKind: 'transport', retryable: false });
    expect(r!.error).toMatch(/^Budget exceeded/);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });
});
