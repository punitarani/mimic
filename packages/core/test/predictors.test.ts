import { describe, expect, it } from 'vitest';
import {
  type BudgetLedger,
  type ChatResponse,
  Gateway,
  isOutputFailure,
  isTransientError,
  LLM_PREDICTOR_MAX_TOKENS,
  LlmPredictor,
  OUTPUT_FAILURE,
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

describe('LLM predictor failures (ADR-0027)', () => {
  it('returns a normalized distribution with the call latency and cost', async () => {
    const [r] = await predictor(async () => reply({})).predict(state, [q]);
    expect(r).toMatchObject({ ok: true, latencyMs: 1200, costUsd: 0.0002, dist: { a: 0.7, b: 0.3 } });
  });

  it('names a max_tokens cutoff instead of calling it invalid JSON; either is the model failing', async () => {
    const [cut] = await predictor(async () =>
      reply({
        content: '',
        finishReason: 'length',
        usage: { inputTokens: 900, outputTokens: 3000, costUsd: 0.0015 },
      }),
    ).predict(state, [q]);
    expect(cut).toMatchObject({ ok: false, costUsd: 0.0015, latencyMs: 1200 });
    expect(cut!.error).toBe(`${OUTPUT_FAILURE.truncated} (${LLM_PREDICTOR_MAX_TOKENS}; 3000 output tokens)`);
    expect(cut!.retryable).toBeUndefined();
    expect(isOutputFailure(cut!.error)).toBe(true);

    const [prose] = await predictor(async () =>
      reply({ content: 'Probably coffee.', finishReason: 'stop' }),
    ).predict(state, [q]);
    expect(prose!.error).toBe(OUTPUT_FAILURE.invalidJson);
    expect(isOutputFailure(prose!.error)).toBe(true);
  });

  it('marks a failed call retryable when it may succeed later', async () => {
    const outcome = async (e: unknown) => (await predictor(() => Promise.reject(e)).predict(state, [q]))[0]!;
    expect(await outcome(httpError(429))).toMatchObject({ ok: false, retryable: true, latencyMs: 0 });
    expect(await outcome(httpError(503))).toMatchObject({ retryable: true });
    expect(
      await outcome(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    ).toMatchObject({ retryable: true });
    expect(await outcome(httpError(400))).toMatchObject({ ok: false, retryable: false });
    expect(isOutputFailure((await outcome(httpError(429))).error)).toBe(false);
  });

  it('does not retry the budget guard', async () => {
    const over: BudgetLedger = { get: async () => ({ spendUsd: 1, budgetUsd: 0.5 }), add: async () => {} };
    const [r] = await predictor(async () => reply({}), over).predict(state, [q]);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(r!.error).toMatch(/^Budget exceeded/);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });
});
