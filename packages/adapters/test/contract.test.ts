import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerToDistribution,
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  type DecisionRequest,
  Gateway,
  GLIDE_MODEL,
  isTimeoutError,
  isTransientError,
  type ModelCallRecord,
  type ModelCallTrace,
  PPLX_DECIDER_MODEL,
  type ProviderCallRunner,
  planDecision,
  predictionQuestion,
  RejectedResponseError,
} from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  answerProblems,
  DECISION_LIST_RATES,
  ENRICH_EXCLUSIONS,
  ENRICH_OUTPUT_SCHEMA,
  ExaEnricher,
  ExaPeopleSearch,
  exaCandidate,
  FastinoDecisions,
  type FetchLike,
  HttpError,
  JevDecisions,
  makeProviders,
  OpenAiDecisionsStub,
  OpenRouterChat,
  OpenRouterEmbedder,
  ParallelEnricher,
  PerplexityDecisions,
  RoutedDecisions,
  relayUrl,
  requestJson,
  schemaFacts,
  WorkersAiDecisions,
} from '../src';

const argmaxKey = (d: Record<string, number>) => Object.entries(d).sort((a, b) => b[1] - a[1])[0]![0];

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8'));

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** A fetch that replays canned responses in order and records every request. */
function replay(...responses: Array<{ status?: number; json: unknown }>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init = {}) => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    calls.push({
      url,
      init,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { fetch, calls };
}

describe('Jev decisions (PLAN §5.1)', () => {
  it('posts to the alpha decisions endpoint and maps the recorded response', async () => {
    const { fetch, calls } = replay({ json: fixture('jev-decisions.json') });
    const jev = new JevDecisions({ fetch, apiKey: 'k' });
    const res = await jev.decide({
      model: 'typesafe/jev-1.13',
      state: { a: 1 },
      questions: { q_a: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } },
    });
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0]!.body).toMatchObject({ model: 'typesafe/jev-1.13', state: { a: 1 } });
    expect(calls[0]!.headers.authorization).toBe('Bearer k');
    expect(res.modelSnapshot).toBe('typesafe/jev-1.13-20260917');
    expect(res.usage).toEqual({ inputTokens: 564, outputTokens: 71, costUsd: 2.3688e-5 });
    expect(res.answers.q_a).toEqual({
      type: 'choice',
      choice: 'a',
      confidence: 0.88,
      probabilities: { a: 0.92, b: 0.08, c: 0 },
    });
    expect(res.answers.q_b).toEqual({ type: 'noul', p: 0.34 });
    expect(res.answers.q_c).toMatchObject({ type: 'score', score: 2.53, confidence: 0.6 });
  });

  it('span-01 gets the request it takes, and its answers come back as asked (ADR-0051)', async () => {
    const asked = fixture('span-decisions.asked.json') as DecisionRequest;
    const plan = planDecision(asked);
    // The exact request span-01 accepted live: the state as JSON text, each option a yes/no question.
    expect(plan.request).toEqual(fixture('span-decisions.request.json'));
    expect(typeof plan.request.state).toBe('string');
    expect(Object.values(plan.request.questions).every((q) => q.type === 'noul')).toBe(true);
    // Jev's requests pass through untouched.
    const jevReq = { ...asked, model: 'typesafe/jev-1.13' };
    expect(planDecision(jevReq).request).toBe(jevReq);

    const { fetch, calls } = replay({ json: fixture('span-decisions.json') });
    const raw = await new JevDecisions({ fetch, apiKey: 'k' }).decide(plan.request);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0]!.body).toMatchObject({ model: 'respan/span-01-20260925' });
    expect(raw.modelSnapshot).toBe('respan/span-01-20260925');
    expect(raw.usage.outputTokens).toBe(0);
    expect(raw.usage.costUsd).toBeGreaterThan(0);

    const res = plan.answer(raw);
    expect(Object.keys(res.answers).sort()).toEqual(['q_a', 'q_b', 'q_c']);
    expect(res.answers.q_b).toEqual({ type: 'noul', p: 0.07934557 });
    const choice = res.answers.q_a!;
    const score = res.answers.q_c!;
    if (choice.type !== 'choice' || score.type !== 'score') throw new Error('wrong answer types');
    expect(Object.keys(choice.probabilities)).toEqual(['a', 'b', 'c']);
    expect(Object.values(choice.probabilities).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
    expect(Object.keys(score.probabilities)).toEqual(['0', '1', '2', '3', '4']);
    expect(score.score).toBeGreaterThan(0);
    // The recomposed answers map onto our option keys like Jev's do.
    const dist = answerToDistribution(
      { type: 'score', options: ['0', '1', '2', '3', '4'].map((key) => ({ key, label: key })) },
      score,
    );
    expect(argmaxKey(dist)).toBe('1');
  });

  it('span-01 refuses a JSON-object state and non-yes/no questions with a 400, not retried', async () => {
    for (const name of ['span-decisions-object-state-400.json', 'span-decisions-choice-400.json']) {
      const { fetch, calls } = replay({ status: 400, json: fixture(name) });
      const err = await new JevDecisions({ fetch })
        .decide({ model: 'respan/span-01-20260925', state: {}, questions: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect(isTransientError(err)).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it('a span-01 blocked by the account’s allowed providers fails at once, without retries', async () => {
    const { fetch, calls } = replay({ status: 404, json: fixture('span-decisions-provider-blocked.json') });
    const err = await new JevDecisions({ fetch })
      .decide({ model: 'respan/span-01-20260925', state: {}, questions: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).toContain('No allowed providers');
    expect(isTransientError(err)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('maps answers onto our Distribution keys (noul → yes/no, score → "0".."4")', async () => {
    const { fetch } = replay({ json: fixture('jev-decisions.json') });
    const res = await new JevDecisions({ fetch }).decide({ model: 'm', state: {}, questions: {} });
    const choice = answerToDistribution(
      {
        type: 'choice',
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
          { key: 'c', label: 'C' },
        ],
      },
      res.answers.q_a!,
    );
    expect(Object.keys(choice)).toEqual(['a', 'b', 'c']);
    expect(choice.c).toBeGreaterThan(0); // clipped away from 0 so log loss stays finite
    expect(Object.values(choice).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
    const noul = answerToDistribution(
      {
        type: 'noul',
        options: [
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ],
      },
      res.answers.q_b!,
    );
    expect(noul.yes).toBeCloseTo(0.34, 3);
    expect(noul.no).toBeCloseTo(0.66, 3);
    const score = answerToDistribution(
      { type: 'score', options: ['0', '1', '2', '3', '4'].map((k) => ({ key: k, label: k })) },
      res.answers.q_c!,
    );
    expect(score['3']).toBeCloseTo(0.58, 3);
  });

  it('tolerates schema drift (extra fields, missing confidence and cost)', async () => {
    const drifted = {
      model: 'typesafe/jev-1.13-20261001',
      answers: { x: { type: 'choice', choice: 'a', probabilities: { a: 1 }, extra: true } },
      usage: { input_tokens: 1, output_tokens: 0, new_field: 1 },
      debug: {},
    };
    const { fetch } = replay({ json: drifted });
    const res = await new JevDecisions({ fetch }).decide({ model: 'm', state: {}, questions: {} });
    expect(res.answers.x).toEqual({ type: 'choice', choice: 'a', probabilities: { a: 1 } });
    expect(res.usage.costUsd).toBe(0);
  });

  it('rejects a malformed response instead of guessing', async () => {
    const { fetch } = replay({ json: { answers: {} } });
    await expect(
      new JevDecisions({ fetch }).decide({ model: 'm', state: {}, questions: {} }),
    ).rejects.toThrow();
  });

  it('builds the §9.6 prediction templates', () => {
    const q = predictionQuestion({
      type: 'choice',
      prompt: 'Coffee or tea?',
      options: [
        { key: 'a', label: 'Coffee' },
        { key: 'b', label: 'Tea' },
      ],
    });
    expect(q).toEqual({
      type: 'choice',
      instructions:
        'Predict how the person described in the state would answer this question, based only on the state: "Coffee or tea?"',
      criteria: { a: 'The person would choose: Coffee', b: 'The person would choose: Tea' },
    });
  });
});

describe('decisions outside OpenRouter (ADR-0068)', () => {
  const clefAsked = fixture('clef-decisions.request.json') as DecisionRequest;
  const pplxAsked = fixture('pplx-decisions.request.json') as DecisionRequest;
  const glideAsked = fixture('glide-decisions.request.json') as DecisionRequest;

  it('runs clef on Workers AI: the @cf model, the bare name in the body, the envelope unwrapped, priced at list rate', async () => {
    const { fetch, calls } = replay({ json: fixture('clef-decisions.json') });
    const clef = new WorkersAiDecisions({ fetch, accountId: 'acct', apiToken: 't' });
    const res = await clef.decide(clefAsked);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef',
    );
    expect(calls[0]!.headers.authorization).toBe('Bearer t');
    // The request as asked, with the model the API expects: nothing else.
    expect(calls[0]!.body).toEqual({ model: 'clef', state: clefAsked.state, questions: clefAsked.questions });
    expect(res.modelSnapshot).toBe('@cf/cloudflare/clef');
    expect(res.usage).toEqual({ inputTokens: 380, outputTokens: 0, costUsd: (380 * 0.24) / 1e6 });
    expect(res.answers.q_canary_noul).toEqual({ type: 'noul', p: 0.8889 });
    expect(res.answers.q_canary_choice).toMatchObject({ type: 'choice', choice: 'a', confidence: 0.9484 });
    expect(res.answers.q_canary_score).toMatchObject({ type: 'score', score: 2.3795 });
    expect(res.raw).toEqual(fixture('clef-decisions.json'));
    // Read as Jev's answers are: score levels by index.
    const dist = answerToDistribution(
      { type: 'score', options: ['0', '1', '2', '3', '4'].map((key) => ({ key, label: key })) },
      res.answers.q_canary_score!,
    );
    expect(argmaxKey(dist)).toBe('2');
  });

  it('prices clef-flash at its own rate and calls its own model', async () => {
    const { fetch, calls } = replay({ json: fixture('clef-flash-decisions.json') });
    const res = await new WorkersAiDecisions({ fetch, accountId: 'acct' }).decide({
      ...clefAsked,
      model: CLEF_FLASH_MODEL,
    });
    expect(calls[0]!.url).toMatch(/\/ai\/run\/@cf\/cloudflare\/clef-flash$/);
    expect(calls[0]!.body?.model).toBe('clef-flash');
    expect(res.modelSnapshot).toBe('@cf/cloudflare/clef-flash');
    expect(res.usage.costUsd).toBeCloseTo((380 * 0.09) / 1e6, 12);
    expect(res.answers.q_canary_choice).toMatchObject({ type: 'choice', choice: 'a' });
  });

  it("rejects a Workers AI error envelope, and doesn't retry a refused token", async () => {
    const refused = replay({ status: 401, json: fixture('clef-decisions-auth-error.json') });
    await expect(
      new WorkersAiDecisions({ fetch: refused.fetch, accountId: 'acct', apiToken: 'bad' }).decide(clefAsked),
    ).rejects.toMatchObject({ name: 'HttpError', status: 401 });
    expect(refused.calls).toHaveLength(1);
    // The same refusal in a 200 envelope is still a 401, so nothing retries it.
    const unsuccessful = replay({ json: fixture('clef-decisions-auth-error.json') });
    await expect(
      new WorkersAiDecisions({ fetch: unsuccessful.fetch, accountId: 'acct' }).decide(clefAsked),
    ).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/Authentication error/) });
    expect(unsuccessful.calls).toHaveLength(1);
  });

  it('refuses before any call without an account ID, or for a model with no list rate', async () => {
    const { fetch, calls } = replay({ json: fixture('clef-decisions.json') });
    const missing = await new WorkersAiDecisions({ fetch }).decide(clefAsked).then(
      () => null,
      (e: Error) => e,
    );
    expect(missing).toMatchObject({
      name: 'DecisionSetupError',
      status: 400,
      message: 'cloudflare/clef needs CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN)',
    });
    expect(isTransientError(missing)).toBe(false);
    await expect(
      new WorkersAiDecisions({ fetch, accountId: 'acct' }).decide({
        ...clefAsked,
        model: 'cloudflare/other',
      }),
    ).rejects.toThrow(/no list rate/);
    expect(calls).toHaveLength(0);
  });

  it("runs Perplexity's decider with exactly model, state and questions, priced at list rate", async () => {
    const { fetch, calls } = replay({ json: fixture('pplx-decisions.json') });
    const res = await new PerplexityDecisions({ fetch, apiKey: 'p' }).decide(pplxAsked);
    expect(calls[0]!.url).toBe('https://api.perplexity.ai/v1/decisions');
    expect(calls[0]!.headers.authorization).toBe('Bearer p');
    // Unknown top-level fields are a 400 there.
    expect(Object.keys(calls[0]!.body ?? {}).sort()).toEqual(['model', 'questions', 'state']);
    expect(calls[0]!.body?.model).toBe('pplx-decider-v1-27b');
    expect(res.modelSnapshot).toBe('pplx-decider-v1-27b');
    expect(res.usage).toEqual({ inputTokens: 408, outputTokens: 3, costUsd: (408 * 0.04) / 1e6 });
    expect(res.answers.q_canary_noul).toEqual({ type: 'noul', p: 0.9910192511294047 });
    expect(res.answers.q_canary_choice).toMatchObject({ type: 'choice', choice: 'a' });
    expect(res.answers.q_canary_score).toMatchObject({ type: 'score', score: 2.2740044727288993 });
  });

  it('retries a rate limit but not a bad request', async () => {
    const limited = replay({ status: 429, json: {} }, { json: fixture('pplx-decisions.json') });
    const res = await new PerplexityDecisions({ fetch: limited.fetch }).decide(pplxAsked);
    expect(limited.calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
    const bad = replay({ status: 400, json: fixture('pplx-decisions-400.json') });
    await expect(new PerplexityDecisions({ fetch: bad.fetch }).decide(pplxAsked)).rejects.toThrow(
      /HTTP 400 .*Noul question must have criteria/,
    );
    expect(bad.calls).toHaveLength(1);
  });

  it('rejects a response from another model or one it cannot read, keeping what the call cost', async () => {
    const good = fixture('pplx-decisions.json') as { model: string; answers: Record<string, unknown> };
    const variants: Array<[unknown, RegExp]> = [
      [{ ...good, model: 'pplx-decider-v2' }, /answered as pplx-decider-v2/],
      [{ ...good, answers: { q_canary_noul: { type: 'multi' } } }, /unreadable response/],
    ];
    for (const [json, message] of variants) {
      const { fetch, calls } = replay({ json });
      const err = await new PerplexityDecisions({ fetch })
        .decide(pplxAsked)
        .catch((e: unknown) => e as RejectedResponseError);
      expect(err).toBeInstanceOf(RejectedResponseError);
      expect((err as RejectedResponseError).message).toMatch(message);
      expect((err as RejectedResponseError).outcome.usage.costUsd).toBe((408 * 0.04) / 1e6);
      expect(calls).toHaveLength(1);
    }
  });

  it('drops only the answers that would be misread, so only their questions fail', async () => {
    const good = fixture('pplx-decisions.json') as {
      answers: Record<string, Record<string, unknown>>;
    };
    const json = {
      ...good,
      answers: {
        q_canary_noul: good.answers.q_canary_noul,
        // Score levels keyed from 1, a choice outside the options, an answer to no question.
        q_canary_score: {
          ...good.answers.q_canary_score,
          probabilities: { 1: 0.1, 2: 0.2, 3: 0.2, 4: 0.2, 5: 0.3 },
        },
        q_canary_choice: { ...good.answers.q_canary_choice, choice: 'd' },
        extra: { type: 'noul', noul: 0.5 },
      },
    };
    const { fetch } = replay({ json });
    const res = await new PerplexityDecisions({ fetch }).decide(pplxAsked);
    expect(Object.keys(res.answers)).toEqual(['q_canary_noul']);
    expect(res.usage.costUsd).toBeGreaterThan(0);
    expect(
      answerProblems(pplxAsked, {
        q_canary_score: { type: 'score', score: 2, probabilities: { 1: 0.5, 5: 0.5 } },
      }),
    ).toEqual(['q_canary_score: probabilities for 5 not in the question']);
  });

  it('runs GLiDE on Fastino as fastino/GLiDE, with exactly three fields, priced at list rate (ADR-0070)', async () => {
    const { fetch, calls } = replay({ json: fixture('glide-decisions.json') });
    const res = await new FastinoDecisions({ fetch, apiKey: 'f' }).decide(glideAsked);
    expect(calls[0]!.url).toBe('https://api.fastino.ai/v1/systemone');
    expect(calls[0]!.headers['x-api-key']).toBe('f');
    // Unknown top-level fields are a 422 there.
    expect(calls[0]!.body).toEqual({
      model: 'fastino/GLiDE',
      state: glideAsked.state,
      questions: glideAsked.questions,
    });
    // It answers as `glide`.
    expect(res.modelSnapshot).toBe('fastino/GLiDE');
    expect(res.usage).toEqual({ inputTokens: 1170, outputTokens: 3, costUsd: (1170 * 0.3) / 1e6 });
    expect(res.answers.q_canary_noul).toEqual({ type: 'noul', p: 0.93 });
    expect(res.answers.q_canary_choice).toMatchObject({ type: 'choice', choice: 'a' });
    // GLiDE's `score` is the winning level, not an expectation; the levels come from `probabilities` either way.
    const score = res.answers.q_canary_score;
    expect(score?.type === 'score' && score.probabilities).toEqual({
      0: 0.02,
      1: 0.1,
      2: 0.46,
      3: 0.35,
      4: 0.07,
    });
    const other = replay({ json: { ...(fixture('glide-decisions.json') as object), model: 'glide-2' } });
    await expect(new FastinoDecisions({ fetch: other.fetch }).decide(glideAsked)).rejects.toThrow(
      /answered as glide-2/,
    );
  });

  it('waits out a warming GLiDE (HTTP 425), then gives up', async () => {
    const warming = { status: 425, json: { detail: 'model_warming' } };
    // The HTTP layer retries a 425 twice at once; the adapter then waits and asks again.
    const warm = replay(warming, warming, warming, { json: fixture('glide-decisions.json') });
    const res = await new FastinoDecisions({ fetch: warm.fetch, warmMs: 0 }).decide(glideAsked);
    expect(warm.calls).toHaveLength(4);
    expect(res.answers.q_canary_noul).toBeDefined();
    const cold = replay(warming);
    await expect(
      new FastinoDecisions({ fetch: cold.fetch, warmMs: 0, warmRetries: 1 }).decide(glideAsked),
    ).rejects.toThrow(/HTTP 425/);
    expect(cold.calls).toHaveLength(6);
  });

  it("prices from the vendor's usage.cost when it sends one", async () => {
    const good = fixture('pplx-decisions.json') as { usage: Record<string, number> };
    const { fetch } = replay({ json: { ...good, usage: { ...good.usage, cost: 0.5 } } });
    expect((await new PerplexityDecisions({ fetch }).decide(pplxAsked)).usage.costUsd).toBe(0.5);
  });

  it('has a list rate for every model it routes outside OpenRouter, from a named source', () => {
    for (const model of [CLEF_MODEL, CLEF_FLASH_MODEL, PPLX_DECIDER_MODEL, GLIDE_MODEL]) {
      const rate = DECISION_LIST_RATES[model];
      expect(rate, model).toBeDefined();
      expect(rate!.inputUsdPerMTok).toBeGreaterThan(0);
      expect(rate!.source).toMatch(/^https:\/\//);
    }
  });

  it('routes each model to its vendor, names it per call, and keeps credentials out of traces', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const name = url.includes('cloudflare')
        ? 'clef-decisions.json'
        : url.includes('perplexity')
          ? 'pplx-decisions.json'
          : url.includes('fastino')
            ? 'glide-decisions.json'
            : 'jev-decisions.json';
      return new Response(JSON.stringify(fixture(name)), { status: 200 });
    };
    const { decisions } = makeProviders(
      {
        CLOUDFLARE_ACCOUNT_ID: 'acct-1234',
        CLOUDFLARE_API_TOKEN: 'cf-token-secret',
        PERPLEXITY_API_KEY: 'pplx-key-secret',
        FASTINO_API_KEY: 'fast_sk_secret',
        OPENROUTER_API_KEY: 'sk-or-v1-secret',
        // Clef never goes through the local relay, which doesn't forward the Cloudflare API.
        EGRESS_RELAY: 'http://127.0.0.1:8790',
        EMBEDDINGS_PROVIDER: 'hash',
      },
      { embeddingModel: 'baai/bge-base-en-v1.5', fetch },
    );
    expect(decisions.providerFor?.(CLEF_MODEL)).toBe('workers-ai-decisions');
    expect(decisions.providerFor?.(PPLX_DECIDER_MODEL)).toBe('perplexity-decisions');
    expect(decisions.providerFor?.(GLIDE_MODEL)).toBe('fastino-decisions');
    expect(decisions.providerFor?.('typesafe/jev-1.13')).toBe('openrouter-decisions');
    expect(decisions.provider).toBe('openrouter-decisions');

    const rows: ModelCallRecord[] = [];
    const traces: ModelCallTrace[] = [];
    const g = new Gateway({
      decisions,
      llm: new OpenRouterChat({ fetch }),
      log: {
        write: async (r, t) => {
          rows.push(r);
          traces.push(t);
        },
      },
      clock: () => 1,
      newId: () => 'id',
    });
    await g.decide({ purpose: 'eval.models' }, clefAsked);
    await g.decide({ purpose: 'eval.models' }, pplxAsked);
    await g
      .decide({ purpose: 'eval.models' }, { ...pplxAsked, model: 'typesafe/jev-1.13' })
      .catch(() => null);
    await g.decide({ purpose: 'eval.models' }, glideAsked);
    expect(urls[0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1234/ai/run/@cf/cloudflare/clef',
    );
    expect(urls[1]).toBe('http://127.0.0.1:8790/api.perplexity.ai/v1/decisions');
    expect(urls[2]).toBe('http://127.0.0.1:8790/openrouter.ai/api/alpha/decisions');
    expect(urls[3]).toBe('http://127.0.0.1:8790/api.fastino.ai/v1/systemone');
    expect(rows.at(-1)!.provider).toBe('fastino-decisions');
    expect(rows.slice(0, 2).map((r) => [r.provider, r.model, r.ok])).toEqual([
      ['workers-ai-decisions', CLEF_MODEL, true],
      ['perplexity-decisions', PPLX_DECIDER_MODEL, true],
    ]);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
    // A router inside a router still names the vendor.
    const nested = new RoutedDecisions(new JevDecisions({ fetch }), [['cloudflare/', decisions]]);
    expect(nested.providerFor(CLEF_MODEL)).toBe('workers-ai-decisions');
    const logged = JSON.stringify({ rows, traces });
    for (const secret of [
      'acct-1234',
      'cf-token-secret',
      'pplx-key-secret',
      'fast_sk_secret',
      'sk-or-v1-secret',
    ])
      expect(logged).not.toContain(secret);
  });
});

describe('OpenRouter chat', () => {
  it('sends json_schema with require_parameters and reasoning effort, never temperature', async () => {
    const { fetch, calls } = replay({ json: fixture('openrouter-chat-json-schema.json') });
    const chat = new OpenRouterChat({ fetch });
    const res = await chat.chat({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: { name: 'probs', schema: { type: 'object' } },
      reasoningEffort: 'low',
      maxTokens: 500,
    });
    const body = calls[0]!.body!;
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body).not.toHaveProperty('temperature');
    expect(body.provider).toEqual({ require_parameters: true, order: ['wafer'], allow_fallbacks: true });
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'probs', strict: true, schema: { type: 'object' } },
    });
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(body.max_tokens).toBe(500);
    expect(calls[0]!.headers).not.toHaveProperty('authorization'); // no key configured → proxy injects it
    expect(JSON.parse(res.content)).toEqual({
      probs: [
        { key: 'a', p: 0.78 },
        { key: 'b', p: 0.22 },
      ],
    });
    expect(res.modelSnapshot).toBe('deepseek/deepseek-v4.1-flash@Wafer');
    expect(res.usage.costUsd).toBe(5.172e-5);
    expect(res.usage.inputTokens).toBe(69);
    expect(res.finishReason).toBe('stop');
  });

  it('reports why generation stopped, so a max_tokens cutoff is distinguishable from bad JSON', async () => {
    const cut = {
      model: 'qwen/qwen3.8-flash',
      provider: 'Alibaba',
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1127, completion_tokens: 3000, cost: 0.0016 },
    };
    const { fetch } = replay({ json: cut });
    const res = await new OpenRouterChat({ fetch }).chat({ model: 'qwen/qwen3.8-flash', messages: [] });
    expect(res.finishReason).toBe('length');
    expect(res.content).toBe('');
    expect(res.usage.outputTokens).toBe(3000);
  });

  it('turns a 200 carrying an error body into a transient HTTP error', async () => {
    const { fetch } = replay({ json: { error: { message: 'Provider returned an empty response' } } });
    const err = await new OpenRouterChat({ fetch })
      .chat({ model: 'xiaomi/mimo-v2.6-flash', messages: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect(isTransientError(err)).toBe(true);
    expect(String(err)).toContain('Provider returned an empty response');
    const limited = replay({ json: { error: { code: 429, message: 'Rate limit exceeded' } } });
    const e429 = await new OpenRouterChat({ fetch: limited.fetch })
      .chat({ model: 'm', messages: [] })
      .catch((e: unknown) => e);
    expect((e429 as HttpError).status).toBe(429);
  });

  it('treats a provider failing mid-generation (finish_reason "error") as a failed call', async () => {
    const { fetch } = replay({
      json: {
        model: 'm',
        choices: [{ message: { content: '' }, finish_reason: 'error', error: { message: 'upstream reset' } }],
      },
    });
    const err = await new OpenRouterChat({ fetch })
      .chat({ model: 'm', messages: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect(String(err)).toContain('upstream reset');
    expect(isTransientError(err)).toBe(true);
  });

  it("doesn't retry a chat call that timed out (the model was too slow), and reports attempts", async () => {
    let calls = 0;
    const slow: FetchLike = async () => {
      calls++;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const err = await new OpenRouterChat({ fetch: slow }).chat({ model: 'm', messages: [] }).catch((e) => e);
    expect(calls).toBe(1);
    expect(isTimeoutError(err)).toBe(true);
    // Other requests still retry timeouts, and a rate limit still retries in chat.
    calls = 0;
    await requestJson({ fetch: slow, retries: 1 }, 'https://x.dev/a', { body: {} }).catch(() => {});
    expect(calls).toBe(2);
    const limited = replay({ status: 429, json: {} }, { json: fixture('openrouter-chat-json-schema.json') });
    const ok = await new OpenRouterChat({ fetch: limited.fetch }).chat({ model: 'm', messages: [] });
    expect(ok.attempts).toBe(2);
  });

  it('only pins providers it has a preference for', () => {
    const body = new OpenRouterChat().buildBody({ model: 'openai/gpt-6-luna', messages: [] });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('temperature');
  });

  it('sends a reasoning budget when given one, else the effort, never both', () => {
    const chat = new OpenRouterChat();
    const base = { model: 'qwen/qwen3.8-flash', messages: [], maxTokens: 2400 };
    expect(chat.buildBody({ ...base, reasoningEffort: 'low' }).reasoning).toEqual({
      effort: 'low',
      exclude: true,
    });
    expect(chat.buildBody({ ...base, reasoningEffort: 'low', reasoningMaxTokens: 1024 }).reasoning).toEqual({
      max_tokens: 1024,
      exclude: true,
    });
    expect(chat.buildBody(base)).not.toHaveProperty('reasoning');
  });
});

describe('embeddings', () => {
  it('maps OpenRouter embeddings and cost', async () => {
    const { fetch, calls } = replay({ json: fixture('openrouter-embeddings.json') });
    const e = new OpenRouterEmbedder('baai/bge-base-en-v1.5', { fetch });
    const r = await e.embed(['a', 'b']);
    expect(calls[0]!.body).toEqual({ model: 'baai/bge-base-en-v1.5', input: ['a', 'b'] });
    expect(r.vectors).toHaveLength(2);
    expect(r.usage.costUsd).toBe(1.1e-7);
  });
});

describe('Exa people search', () => {
  it('requests the people category and parses structured person entities', async () => {
    const { fetch, calls } = replay({ json: fixture('exa-people-search.json') });
    const r = await new ExaPeopleSearch({ fetch, apiKey: 'exa' }).search('"Avery Quinn" engineer', {
      numResults: 5,
    });
    expect(calls[0]!.url).toBe('https://api.exa.ai/search');
    expect(calls[0]!.headers['x-api-key']).toBe('exa');
    expect(calls[0]!.body).toMatchObject({ category: 'people', numResults: 5 });
    expect(r.costUsd).toBe(0.007);
    expect(r.candidates[0]).toMatchObject({
      provider: 'exa',
      name: 'Avery Quinn',
      headline: 'Senior Software Engineer at Northwind Labs',
      location: 'San Francisco, California, United States',
      url: 'https://www.linkedin.com/in/avery-quinn-example',
    });
    expect(r.candidates[0]!.summary).toContain('Contoso');
  });

  it("looks up the person's own link with /contents and keeps their exact URL", async () => {
    const { fetch, calls } = replay({ json: fixture('exa-contents.json') });
    const link = 'https://linkedin.com/in/avery-quinn-example/';
    const r = await new ExaPeopleSearch({ fetch, apiKey: 'exa' }).lookup(link);
    expect(calls[0]!.url).toBe('https://api.exa.ai/contents');
    expect(calls[0]!.headers['x-api-key']).toBe('exa');
    expect(calls[0]!.body).toMatchObject({ urls: [link] });
    expect(r.costUsd).toBe(0.001);
    expect(r.candidates).toEqual([
      expect.objectContaining({
        provider: 'exa',
        name: 'Avery Quinn',
        headline: 'Senior Software Engineer at Northwind Labs',
        location: 'San Francisco, California, United States',
        url: link,
      }),
    ]);
  });

  it('gives no candidate for a link Exa cannot read', async () => {
    const { fetch } = replay({
      json: {
        requestId: 'x',
        results: [],
        statuses: [{ id: 'https://linkedin.com/in/nobody', status: 'error', error: { httpStatusCode: 404 } }],
        costDollars: { total: 0 },
      },
    });
    const r = await new ExaPeopleSearch({ fetch }).lookup('https://linkedin.com/in/nobody');
    expect(r.candidates).toEqual([]);
  });
});

/** A pass-through runner that records the model each provider call is logged under (the gateway's job). */
function runner() {
  const models: string[] = [];
  const run: ProviderCallRunner = (model, _request, call) => {
    models.push(model);
    return call();
  };
  return { run, models };
}

const exaPage = (over: Record<string, unknown>) => ({
  requestId: 'x',
  results: [{ id: 'u', title: 'Avery Quinn', url: 'https://avery.example.dev', text: 'Avery', ...over }],
  costDollars: { total: 0.001 },
});

describe('Exa enrichment', () => {
  const subject = { name: 'Avery Quinn', location: 'San Francisco' };

  it('maps a profile with a person entity to sourced facts in one logged call', async () => {
    const { fetch, calls } = replay({ json: fixture('exa-contents.json') });
    const url = 'https://www.linkedin.com/in/avery-quinn-example';
    const { run, models } = runner();
    const r = await new ExaEnricher({ fetch, apiKey: 'exa' }).enrich({ ...subject, url }, run);
    expect(models).toEqual(['exa:contents']);
    expect(calls[0]!.url).toBe('https://api.exa.ai/contents');
    expect(calls[0]!.body).toMatchObject({ urls: [url] });
    expect(r.costUsd).toBe(0.001);
    expect(r.facts.map((f) => [f.predicate, f.object])).toEqual([
      ['jobTitle', 'Senior Software Engineer'],
      ['worksAt', 'Northwind Labs'],
      ['workedAt', 'Contoso'],
      ['educatedAt', 'Example State University'], // the school alone, one KG organization
      ['livesIn', 'San Francisco, California, United States'],
    ]);
    expect(r.facts.every((f) => f.sourceUrl === url && f.confidence === 0.85)).toBe(true);
  });

  it('logs the schema summary as its own call, only for a page with no person entity', async () => {
    const { fetch, calls } = replay(
      { json: fixture('exa-contents-page.json') },
      { json: fixture('exa-contents-summary.json') },
    );
    const url = 'https://avery.example.dev';
    const { run, models } = runner();
    const r = await new ExaEnricher({ fetch }).enrich({ ...subject, url }, run);
    expect(models).toEqual(['exa:contents', 'exa:summary']);
    expect(calls[1]!.body).toMatchObject({ urls: [url], summary: { schema: { type: 'object' } } });
    expect(r.costUsd).toBe(0.002);
    expect(r.facts).toContainEqual({
      predicate: 'worksAt',
      object: 'Northwind Labs',
      confidence: 0.6,
      sourceUrl: url,
    });
    expect(r.facts).toContainEqual({
      predicate: 'hasInterest',
      object: 'Bouldering',
      confidence: 0.6,
      sourceUrl: url,
    });
  });

  it('makes no second call when Exa could not read the page', async () => {
    const { fetch, calls } = replay({ json: { requestId: 'x', results: [], costDollars: { total: 0 } } });
    const { run } = runner();
    const r = await new ExaEnricher({ fetch }).enrich({ ...subject, url: 'https://avery.example.dev' }, run);
    expect(calls).toHaveLength(1);
    expect(r.facts).toEqual([]);
  });

  it('does not summarize a LinkedIn page that came back without an entity', async () => {
    const { fetch, calls } = replay({ json: exaPage({ url: 'https://www.linkedin.com/in/avery' }) });
    const { run } = runner();
    const r = await new ExaEnricher({ fetch }).enrich(
      { ...subject, url: 'https://linkedin.com/in/avery/' },
      run,
    );
    expect(calls).toHaveLength(1);
    expect(r.facts).toEqual([]);
  });

  it('reads a summary in a code fence, and fails a summary of the wrong shape', async () => {
    const fenced = exaPage({ summary: '```json\n{"current_employer":"Northwind Labs"}\n```' });
    let { fetch } = replay({ json: exaPage({}) }, { json: fenced });
    const r = await new ExaEnricher({ fetch }).enrich(
      { ...subject, url: 'https://avery.example.dev' },
      runner().run,
    );
    expect(r.facts.map((f) => f.object)).toEqual(['Northwind Labs']);

    ({ fetch } = replay({ json: exaPage({}) }, { json: exaPage({ summary: '{"skills":"not a list"}' }) }));
    await expect(
      new ExaEnricher({ fetch }).enrich({ ...subject, url: 'https://avery.example.dev' }, runner().run),
    ).rejects.toThrow();
    ({ fetch } = replay({ json: exaPage({}) }, { json: exaPage({ summary: 'not json' }) }));
    await expect(
      new ExaEnricher({ fetch }).enrich({ ...subject, url: 'https://avery.example.dev' }, runner().run),
    ).rejects.toThrow();
  });
});

describe('schemaFacts', () => {
  it('keeps a few facts per field and does not repeat the current employer as a past one', () => {
    const facts = schemaFacts(
      {
        current_employer: 'Handshake AI',
        employer_history: ['Handshake AI', 'Prospify', 'NOCO', 'Slash', 'Contoso', 'Fabrikam'],
        skills: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
      () => ({ confidence: 0.6 }),
    );
    expect(facts.filter((f) => f.predicate === 'workedAt').map((f) => f.object)).toEqual([
      'Prospify',
      'NOCO',
      'Slash',
      'Contoso',
    ]);
    expect(facts.filter((f) => f.predicate === 'hasSkill')).toHaveLength(4);
  });
});

describe('Exa person entities', () => {
  const entity = (workHistory: unknown[]) =>
    exaPage({
      entities: [{ type: 'person', properties: { name: 'Avery Quinn', workHistory, educationHistory: [] } }],
    }).results[0] as Parameters<typeof exaCandidate>[0];

  it('treats only a dated role with no end as current', () => {
    const c = exaCandidate(
      entity([
        { title: 'Intern', company: { name: 'Contoso' }, dates: null },
        { title: 'Engineer', company: { name: 'Fabrikam' }, dates: { from: '2020-01-01', to: '2022-01-01' } },
        { title: 'Lead', company: { name: 'Northwind Labs' }, dates: { from: '2022-02-01', to: null } },
      ]),
    );
    expect(c.headline).toBe('Lead at Northwind Labs');
    expect(c.facts?.map((f) => [f.predicate, f.object])).toEqual([
      ['jobTitle', 'Lead'],
      ['worksAt', 'Northwind Labs'],
      ['workedAt', 'Contoso'], // undated: a past employer, not a current one
      ['workedAt', 'Fabrikam'],
    ]);
    // Facts carried on a candidate leave the source to the candidate's URL.
    expect(c.facts?.every((f) => f.sourceUrl === undefined)).toBe(true);
  });

  it('gives an entity-free result no facts', () => {
    expect(exaCandidate(exaPage({}).results[0] as Parameters<typeof exaCandidate>[0]).facts).toBeUndefined();
  });
});

describe('Parallel enrichment', () => {
  it('creates a task run with a JSON output schema and maps fields to sourced facts', async () => {
    const { fetch, calls } = replay(
      { json: fixture('parallel-task-created.json') },
      { json: fixture('parallel-task-result.json') },
    );
    const { run, models } = runner();
    const r = await new ParallelEnricher({ fetch }).enrich(
      {
        name: 'Avery Quinn',
        location: 'San Francisco',
        url: 'https://www.linkedin.com/in/avery-quinn-example',
      },
      run,
    );
    expect(models).toEqual(['parallel:task']);
    expect(calls[0]!.url).toBe('https://api.parallel.ai/v1/tasks/runs');
    expect(calls[0]!.body).toMatchObject({
      processor: 'base',
      task_spec: { output_schema: { type: 'json' } },
    });
    expect(calls[1]!.url).toContain('/v1/tasks/runs/trun_0000000000000000000000000000example/result');
    expect(r.facts).toContainEqual({
      predicate: 'worksAt',
      object: 'Northwind Labs',
      confidence: 0.85,
      sourceUrl: 'https://www.linkedin.com/in/avery-quinn-example',
    });
    expect(r.facts.find((f) => f.predicate === 'educatedAt')?.sourceUrl).toBeUndefined();
    expect(r.facts.filter((f) => f.predicate === 'hasSkill')).toHaveLength(2);
  });
});

describe('http', () => {
  it('rewrites provider URLs through the egress relay', () => {
    expect(relayUrl('https://openrouter.ai/api/v1/x?y=1', 'http://127.0.0.1:8790/')).toBe(
      'http://127.0.0.1:8790/openrouter.ai/api/v1/x?y=1',
    );
    expect(relayUrl('https://api.exa.ai/search')).toBe('https://api.exa.ai/search');
  });

  it('retries transient statuses and gives up on client errors', async () => {
    const flaky = replay({ status: 429, json: {} }, { json: { ok: 1 } });
    const ok = await requestJson({ fetch: flaky.fetch, retries: 2 }, 'https://x.dev/a', { body: {} });
    expect(ok).toMatchObject({ json: { ok: 1 }, status: 200, attempts: 2 });
    // Latency is the attempt that answered, not the failed attempt plus the 250 ms backoff before it.
    expect(ok.latencyMs).toBeLessThan(200);
    expect(flaky.calls).toHaveLength(2);
    const bad = replay({ status: 400, json: { error: 'no' } });
    await expect(
      requestJson({ fetch: bad.fetch, retries: 2 }, 'https://x.dev/a', { body: {} }),
    ).rejects.toThrow(/HTTP 400/);
    expect(bad.calls).toHaveLength(1);
  });

  it('keeps the OpenAI decisions stub out of scope', async () => {
    await expect(new OpenAiDecisionsStub().decide({ model: 'x', state: {}, questions: {} })).rejects.toThrow(
      /not implemented/,
    );
  });
});

describe('special-category data is never requested from the web (ADR-0043)', () => {
  it('asks enrichment for professional fields only, and tells it to leave special categories out', () => {
    const fields = Object.keys(ENRICH_OUTPUT_SCHEMA.properties);
    expect(
      fields.filter((f) => /relig|faith|politic|party|vote|health|medical|sexual|orientation/i.test(f)),
    ).toEqual([]);
    for (const area of ['health', 'religion', 'politics', 'sexuality'])
      expect(ENRICH_EXCLUSIONS).toContain(area);
  });
});
