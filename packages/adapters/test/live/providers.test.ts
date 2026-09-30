// Live smoke tests: one real call per provider. Run with `pnpm test:live` (LIVE=1). Each call costs a fraction of
// a cent. Keys come from the environment; in the Claude Code remote env the outbound proxy injects them.
import {
  DEFAULT_CONFIG,
  Gateway,
  LlmPredictor,
  type PersonState,
  parsePredictorId,
  type Question,
  ulid,
} from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  ExaEnricher,
  ExaPeopleSearch,
  JevDecisions,
  OpenRouterChat,
  OpenRouterEmbedder,
  ParallelEnricher,
} from '../../src';

const LIVE = process.env.LIVE === '1';
const env = process.env;
const or = { ...(env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY } : {}) };

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!LIVE)('live providers', () => {
  it('Jev answers a batched noul/choice/score request', async () => {
    const r = await new JevDecisions(or).decide({
      model: 'typesafe/jev-1.13',
      state: { identity: { occupation: 'Teacher' }, evidence: [] },
      questions: {
        n: { type: 'noul', instructions: 'Is the person a teacher?', criteria: { true: 'Yes', false: 'No' } },
        c: { type: 'choice', instructions: 'Which fits best?', criteria: { a: 'Teacher', b: 'Pilot' } },
        s: { type: 'score', instructions: 'How likely to enjoy reading?', criteria: ['Low', 'Mid', 'High'] },
      },
    });
    expect(r.modelSnapshot).toMatch(/^typesafe\/jev-1\.13-\d{8}$/);
    expect(r.answers.n?.type).toBe('noul');
    expect(r.answers.c?.type).toBe('choice');
    expect(r.answers.s?.type).toBe('score');
    expect(r.usage.costUsd).toBeGreaterThan(0);
  }, 30_000);

  it('OpenRouter chat returns schema-valid JSON with cost', async () => {
    const r = await new OpenRouterChat(or).chat({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'Return {"ok": true}.' }],
      jsonSchema: {
        name: 'ok',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
      reasoningEffort: 'low',
      maxTokens: 300,
    });
    expect(JSON.parse(r.content)).toEqual({ ok: true });
    expect(r.usage.costUsd).toBeGreaterThan(0);
  }, 60_000);

  // One prediction per LLM shadow in the default config, through the real LlmPredictor: its prompt version's text,
  // schema (with the option-key enum under predict.v2), reasoning control and cap for that model (ADR-0041).
  const shadows = DEFAULT_CONFIG.predictor.shadows
    .map((id) => ({ id, spec: parsePredictorId(id) }))
    .filter((s) => s.spec.kind === 'llm');
  it.each(shadows.map((s) => [s.id, s.spec] as const))(
    'shadow %s returns a valid distribution',
    async (_, spec) => {
      const gateway = new Gateway({
        decisions: new JevDecisions(or),
        llm: new OpenRouterChat(or),
        log: { write: async () => {} },
        clock: Date.now,
        newId: ulid,
      });
      const predictor = new LlmPredictor(gateway, spec.model, { purpose: 'live.test' }, spec.promptVersion);
      const state: PersonState = {
        identity: { occupation: 'Teacher', location: 'Lisbon' },
        traits: [],
        insights: [],
        evidence: [
          {
            seq: 1,
            q: 'Quiet weekend or a night out?',
            type: 'choice',
            options: ['Quiet weekend', 'Night out'],
            answer: 'Quiet weekend',
          },
        ],
        meta: { evidenceSeqMax: 1, stateHash: 'live', builder: 'full', tokens: 60 },
      };
      const question: Question = {
        id: ulid(),
        mimicId: 'live',
        seq: 2,
        kind: 'adaptive',
        type: 'score',
        domain: 'casual',
        prompt: 'How often do you go to loud parties?',
        options: ['Never', 'Rarely', 'Sometimes', 'Often', 'Always'].map((label, i) => ({
          key: String(i),
          label,
        })),
        facetIds: [],
        provenance: { generator: 'live', configHash: 'live', promptVersion: 'live' },
      };
      const [r] = await predictor.predict(state, [question]);
      expect(r!.error ?? null).toBeNull();
      expect(Object.keys(r!.dist).sort()).toEqual(['0', '1', '2', '3', '4']);
      expect(r!.costUsd).toBeGreaterThan(0);
    },
    90_000,
  );

  it('embeddings return 768-d vectors', async () => {
    const r = await new OpenRouterEmbedder('baai/bge-base-en-v1.5', or).embed(['hello']);
    expect(r.vectors[0]).toHaveLength(768);
  }, 30_000);

  it('Exa people search returns candidates', async () => {
    const r = await new ExaPeopleSearch(env.EXA_API_KEY ? { apiKey: env.EXA_API_KEY } : {}).search(
      'software engineer San Francisco',
      { numResults: 1 },
    );
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]!.url).toMatch(/^https?:\/\//);
  }, 30_000);

  it('Exa resolves a LinkedIn link to the person (the intake link lookup)', async () => {
    const url = 'https://www.linkedin.com/in/williamhgates';
    const r = await new ExaPeopleSearch(env.EXA_API_KEY ? { apiKey: env.EXA_API_KEY } : {}).lookup(url);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ name: 'Bill Gates', url });
  }, 30_000);

  it('Exa enrichment maps a LinkedIn profile to sourced facts', async () => {
    const url = 'https://www.linkedin.com/in/williamhgates';
    const r = await new ExaEnricher(env.EXA_API_KEY ? { apiKey: env.EXA_API_KEY } : {}).enrich(
      { name: 'Bill Gates', location: 'Seattle', url },
      (_model, _request, call) => call(),
    );
    expect(r.facts.some((f) => f.predicate === 'worksAt' || f.predicate === 'workedAt')).toBe(true);
    expect(r.facts.every((f) => f.sourceUrl === url)).toBe(true);
    expect(r.costUsd).toBeGreaterThan(0);
  }, 30_000);

  it('Parallel enrichment runs a task (skipped when the host is unreachable)', async (ctx) => {
    if (!(await reachable('https://api.parallel.ai'))) ctx.skip();
    const r = await new ParallelEnricher(env.PARALLEL_API_KEY ? { apiKey: env.PARALLEL_API_KEY } : {}).enrich(
      {
        name: 'Ada Lovelace',
        location: 'London',
        url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
      },
      (_model, _request, call) => call(),
    );
    expect(Array.isArray(r.facts)).toBe(true);
  }, 200_000);
});
