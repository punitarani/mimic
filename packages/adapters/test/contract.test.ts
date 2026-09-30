import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerToDistribution, predictionQuestion } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  ExaPeopleSearch,
  type FetchLike,
  JevDecisions,
  OpenAiDecisionsStub,
  OpenRouterChat,
  OpenRouterEmbedder,
  ParallelEnricher,
  relayUrl,
  requestJson,
} from '../src';

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
  });

  it('only pins providers it has a preference for', () => {
    const body = new OpenRouterChat().buildBody({ model: 'openai/gpt-6-luna', messages: [] });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('temperature');
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
});

describe('Parallel enrichment', () => {
  it('creates a task run with a JSON output schema and maps fields to sourced facts', async () => {
    const { fetch, calls } = replay(
      { json: fixture('parallel-task-created.json') },
      { json: fixture('parallel-task-result.json') },
    );
    const r = await new ParallelEnricher({ fetch }).enrich({
      name: 'Avery Quinn',
      location: 'San Francisco',
      url: 'https://www.linkedin.com/in/avery-quinn-example',
    });
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
    await expect(
      requestJson({ fetch: flaky.fetch, retries: 2 }, 'https://x.dev/a', { body: {} }),
    ).resolves.toEqual({
      json: { ok: 1 },
      status: 200,
    });
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
