// Live smoke tests: one real call per provider. Run with `pnpm test:live` (LIVE=1). Each call costs a fraction of
// a cent. Keys come from the environment; in the Claude Code remote env the outbound proxy injects them.
import {
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  DEFAULT_CONFIG,
  decisionChallenger,
  FLAG_KEYS,
  Gateway,
  GLIDE_MODEL,
  LlmPredictor,
  makePredictor,
  type PersonState,
  PPLX_DECIDER_MODEL,
  parsePredictorId,
  type Question,
  SPAN_MODEL,
  StaticFlags,
  ulid,
} from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  ExaEnricher,
  ExaPeopleSearch,
  FastinoDecisions,
  JevDecisions,
  OpenRouterChat,
  OpenRouterEmbedder,
  ParallelEnricher,
  PerplexityDecisions,
  WorkersAiDecisions,
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

  // ADR-0068: the decision models served outside OpenRouter. Each runs only with its credentials; its response is the
  // one to replace the schema-built (clef) or documented (Perplexity) fixture with.
  const sameAsJev = {
    state: { identity: { occupation: 'Teacher' }, evidence: [] },
    questions: {
      n: {
        type: 'noul' as const,
        instructions: 'Is the person a teacher?',
        criteria: { true: 'Yes', false: 'No' },
      },
      c: {
        type: 'choice' as const,
        instructions: 'Which fits best?',
        criteria: { a: 'Teacher', b: 'Pilot' },
      },
      s: {
        type: 'score' as const,
        instructions: 'How likely to enjoy reading?',
        criteria: ['Low', 'Mid', 'High'],
      },
    },
  };
  for (const model of [CLEF_MODEL, CLEF_FLASH_MODEL])
    it.skipIf(!env.CLOUDFLARE_ACCOUNT_ID)(
      `${model} answers the same request on Workers AI`,
      async () => {
        const r = await new WorkersAiDecisions({
          accountId: env.CLOUDFLARE_ACCOUNT_ID,
          ...(env.CLOUDFLARE_API_TOKEN ? { apiToken: env.CLOUDFLARE_API_TOKEN } : {}),
        }).decide({ model, ...sameAsJev });
        console.log(JSON.stringify(r.raw));
        expect(r.answers.n?.type).toBe('noul');
        expect(r.answers.c?.type).toBe('choice');
        expect(r.answers.s?.type).toBe('score');
        expect(r.usage.costUsd).toBeGreaterThan(0);
      },
      30_000,
    );

  it.skipIf(!env.PERPLEXITY_API_KEY)(
    "Perplexity's decider answers the same request",
    async () => {
      const r = await new PerplexityDecisions({ apiKey: env.PERPLEXITY_API_KEY }).decide({
        model: PPLX_DECIDER_MODEL,
        ...sameAsJev,
      });
      console.log(JSON.stringify(r.raw));
      expect(r.modelSnapshot).toBe('pplx-decider-v1-27b');
      expect(r.answers.s?.type).toBe('score');
      expect(r.usage.costUsd).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(!env.FASTINO_API_KEY)(
    "Fastino's GLiDE answers the same request",
    async () => {
      const r = await new FastinoDecisions({ apiKey: env.FASTINO_API_KEY }).decide({
        model: GLIDE_MODEL,
        ...sameAsJev,
      });
      console.log(JSON.stringify(r.raw));
      expect(r.modelSnapshot).toBe('fastino/GLiDE');
      expect(r.answers.s?.type).toBe('score');
      expect(r.usage.costUsd).toBeGreaterThan(0);
    },
    // A cold model warms for about a minute, and GLiDE may think on a hard question.
    300_000,
  );

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

  // The production primary with `decisions-model` at span-01, through the real Gateway, router and adapter: span-01
  // answers a choice, a yes/no and a score question in one request, each option asked as its own yes/no (ADR-0051).
  it('the primary predicts through span-01 when the flag says so, and never falls back', async () => {
    const rows: Array<{ model: string; ok: boolean; error: string | null }> = [];
    const gateway = new Gateway({
      decisions: new JevDecisions(or),
      decisionRouter: decisionChallenger(new StaticFlags({ [FLAG_KEYS.decisionsModel]: 'span-01' })),
      llm: new OpenRouterChat(or),
      log: { write: async (r) => void rows.push({ model: r.model, ok: r.ok, error: r.error }) },
      clock: Date.now,
      newId: ulid,
    });
    const state: PersonState = {
      identity: { occupation: 'Nurse' },
      traits: [],
      insights: [],
      evidence: [
        {
          seq: 1,
          q: 'Plan trips in detail or go with the flow?',
          type: 'choice',
          options: ['Plan', 'Flow'],
          answer: 'Plan',
        },
      ],
      meta: { evidenceSeqMax: 1, stateHash: 'live', builder: 'full', tokens: 60 },
    };
    const q = (type: Question['type'], labels: string[]): Question => ({
      id: ulid(),
      mimicId: 'live',
      seq: 2,
      kind: 'adaptive',
      type,
      domain: 'casual',
      prompt: 'How do you like your weekends?',
      options: labels.map((label, i) => ({
        key: type === 'noul' ? (i ? 'no' : 'yes') : String(type === 'score' ? i : 'abc'[i]),
        label,
      })),
      facetIds: [],
      provenance: { generator: 'live', configHash: 'live', promptVersion: 'live' },
    });
    const qs = [
      q('choice', ['Planned', 'Spontaneous', 'At home']),
      q('noul', ['Yes', 'No']),
      q('score', ['1', '2', '3', '4', '5']),
    ];
    const rs = await makePredictor(gateway, DEFAULT_CONFIG.predictor.primary, {
      purpose: 'predict.primary',
      mimicId: 'live',
    }).predict(state, qs);
    expect(rows).toEqual([{ model: SPAN_MODEL, ok: true, error: null }]);
    for (const r of rs) {
      expect(r.ok).toBe(true);
      expect(r.modelSnapshot).toBe(SPAN_MODEL);
      expect(Object.values(r.dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  }, 60_000);

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
