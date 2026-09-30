import {
  DEFAULT_CONFIG_V6,
  type EngineDeps,
  ONTOLOGY_V2,
  type QuestionRecord,
  registerConfig,
  SENSITIVE_AREAS,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { M10_CANDIDATE_CONFIG, registerNamedConfig } from '../src/configs';
import { ROGUE_PROMPTS } from '../src/fakes';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { reproduceOnline } from '../src/replay';
import { runSession, SessionScript } from '../src/session';

/**
 * gen.v3, gates.v3, reserve.v2, reflect.v2 and hyp.v2 under the M10 candidate config (ADR-0042). Offline fakes: the
 * generator tags whatever it is told to target and appends rogue drafts, so these check the machinery only.
 */

let engine: LocalEngine;
let consented: string;
let plain: string;
let reserveOnly: string;
const SENSITIVE = new Map(ONTOLOGY_V2.filter((f) => f.sensitive).map((f) => [f.id, f.sensitive!]));
const ALL_AREAS = { politics: true, religion: true, sexuality: true, health: true, money: true };

const script = (name: string, consents: Record<string, boolean> = {}) =>
  SessionScript.parse({
    intake: { name, location: 'Porto, PT', occupation: 'Teacher' },
    consentResearch: true,
    seed: name,
    consents,
  });

async function trace(deps: EngineDeps, key: string) {
  return JSON.parse((await deps.blobs.get(key))!) as {
    request: { messages: Array<{ role: string; content: string }> };
  };
}

async function calls(id: string, purpose: string) {
  return (await engine.deps.store.listModelCalls({ mimicId: id, limit: 10_000 })).filter(
    (c) => c.purpose === purpose,
  );
}

const generated = (qs: QuestionRecord[]) =>
  qs.filter((q) => q.kind === 'adaptive' && q.provenance.promptVersion === 'gen.v3');

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'gen-v3' });
  const configHash = await registerNamedConfig(engine.deps, 'm10-candidate');
  consented = (await runSession(engine, script('Consented', ALL_AREAS), { turns: 30, configHash })).mimicId;
  plain = (await runSession(engine, script('Plain'), { turns: 30, configHash })).mimicId;
  const reserveHash = await registerConfig(
    engine.deps,
    { ...M10_CANDIDATE_CONFIG, generator: { ...M10_CANDIDATE_CONFIG.generator, batchSize: 0 } },
    'test.reserve-only',
  );
  reserveOnly = (await runSession(engine, script('Reserve'), { turns: 25, configHash: reserveHash })).mimicId;
}, 180_000);

afterAll(() => engine.close());

describe('gen.v3 and gates.v3 (ADR-0042)', () => {
  it('pins the candidate to cfg.default.v6, so a new default does not change what it measures (ADR-0048)', () => {
    expect(M10_CANDIDATE_CONFIG.predictor).toEqual(DEFAULT_CONFIG_V6.predictor);
    expect(M10_CANDIDATE_CONFIG.selector).toEqual(DEFAULT_CONFIG_V6.selector);
  });

  it('gates every generated question with gates.v3 and records the areas it was checked against', async () => {
    for (const id of [consented, plain]) {
      const qs = generated(await engine.deps.store.listQuestions(id));
      expect(qs.length).toBeGreaterThan(10);
      for (const q of qs) {
        const quality = q.quality as {
          gatesVersion: string;
          gates: Record<string, number>;
          sensitiveAsked: string[];
        };
        expect(quality.gatesVersion).toBe('gates.v3');
        expect(Object.keys(quality.gates)).toEqual(expect.arrayContaining(['concrete', 'demeaning']));
        const tagged = q.facetIds.flatMap((f) => SENSITIVE.get(f) ?? []);
        expect(quality.sensitiveAsked).toEqual(SENSITIVE_AREAS.filter((a) => !tagged.includes(a)));
      }
    }
  });

  it('never pools a self-rating, an untagged sensitive question or a loaded one', async () => {
    for (const id of [consented, plain]) {
      const prompts = (await engine.deps.store.listQuestions(id)).map((q) => q.prompt);
      expect(prompts).not.toContain(ROGUE_PROMPTS.selfRating);
      expect(prompts).not.toContain(ROGUE_PROMPTS.untagged);
      expect(prompts).not.toContain(ROGUE_PROMPTS.loaded);
    }
    // Politics was consented, so the direct political question is fair game there, and only there.
    expect((await engine.deps.store.listQuestions(consented)).map((q) => q.prompt)).toContain(
      ROGUE_PROMPTS.political,
    );
    expect((await engine.deps.store.listQuestions(plain)).map((q) => q.prompt)).not.toContain(
      ROGUE_PROMPTS.political,
    );
  });

  it('asks about sensitive facets only with consent', async () => {
    const plainQs = await engine.deps.store.listQuestions(plain);
    for (const q of plainQs)
      expect(
        q.facetIds.filter((f) => SENSITIVE.has(f)),
        q.prompt,
      ).toEqual([]);
    const consentedQs = await engine.deps.store.listQuestions(consented);
    expect(consentedQs.some((q) => q.facetIds.some((f) => SENSITIVE.has(f)))).toBe(true);
  });

  it('shows the generator categories, a category quota and only consented sensitive facets', async () => {
    for (const [id, sensitive] of [
      [consented, true],
      [plain, false],
    ] as const) {
      const gen = await calls(id, 'pool.generate');
      expect(gen.length).toBeGreaterThan(0);
      for (const c of gen) {
        const { messages } = (await trace(engine.deps, c.r2TraceKey)).request;
        const system = messages.find((m) => m.role === 'system')!.content;
        const user = messages.find((m) => m.role === 'user')!.content;
        expect(system).toMatch(/^You write short, concrete questions/);
        expect(system).toContain('Forbidden: "How well does this describe you"');
        expect(system).toMatch(/^care_harm \| care \| .* \| Values, beliefs and politics$/m);
        expect(system.includes('[sensitive: politics]')).toBe(sensitive);
        expect(user).toMatch(/^Category quota: \{"psychology":\d+,"values":\d+,"life":\d+,"work":\d+\}$/m);
        const allowed = user.match(/^Sensitive facets you may ask about: (.*)$/m)![1]!;
        if (sensitive) expect(allowed.split(', ').sort()).toEqual([...SENSITIVE.keys()].sort());
        else expect(allowed).toBe('none');
      }
    }
  });

  it('uses reflect.v2 and hyp.v2, which mark sensitive facets and forbid inferring them', async () => {
    const [reflectCall] = await calls(consented, 'reflect');
    const refl = (await trace(engine.deps, reflectCall!.r2TraceKey)).request.messages[0]!.content;
    expect(refl).toMatch(/Never infer politics, religion,\s+sexuality, health, finances/);
    expect(refl).toContain('political_leaning [sensitive]');
    const [plainReflect] = await calls(plain, 'reflect');
    const plainRefl = (await trace(engine.deps, plainReflect!.r2TraceKey)).request.messages[0]!.content;
    expect(plainRefl.slice(plainRefl.indexOf('ONTOLOGY facet IDs'))).not.toContain('[sensitive]');
    const [hyp] = await calls(consented, 'hypotheses');
    const hypSystem = (await trace(engine.deps, hyp!.r2TraceKey)).request.messages[0]!.content;
    expect(hypSystem).toMatch(/only where the state holds the person's own answer/);
  });
});

describe('reserve.v2 (ADR-0042)', () => {
  it('carries a session when generation yields nothing, spread across facets and inside the scope', async () => {
    const qs = await engine.deps.store.listQuestions(reserveOnly);
    const served = qs.filter((q) => q.kind === 'adaptive' && q.seq !== null);
    expect(served.length).toBeGreaterThanOrEqual(12);
    for (const q of served) {
      expect(q.itemKey).toMatch(/^reserve\.v[12]\//);
      expect(q.provenance.promptVersion).toBe('reserve.v2');
      expect(
        q.facetIds.filter((f) => SENSITIVE.has(f)),
        q.prompt,
      ).toEqual([]);
    }
    // Least-asked facets first: the first dozen reserve questions touch at least ten different facets.
    const first = served.slice(0, 12).flatMap((q) => q.facetIds);
    expect(new Set(first).size).toBeGreaterThanOrEqual(10);
  });
});

describe('reproducibility under the M10 candidate (ADR-0042)', () => {
  it('rebuilds every sealed state and prediction on ontology v2 with gen.v3, gates.v3 and reserve.v2', async () => {
    // Human pacing, so derived traits and insights are old enough to enter sealed states (STATE_SETTLE_MS).
    let t = Date.now();
    const e = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    try {
      const configHash = await registerNamedConfig(e.deps, 'm10-candidate');
      for (const name of ['Repro 1', 'Repro 2'])
        await runSession(e, { ...script(name, ALL_AREAS), consentResearch: true }, { turns: 24, configHash });
      const r = await reproduceOnline(e.deps, { seed: 's', name: 'repro v2' }, 'hash');
      expect(r.n).toBeGreaterThan(30);
      expect(r.stateHashMatchRate).toBe(1);
      expect(r.meanAbsItemAccDelta).toBe(0);
      expect(r.argmaxAgreement).toBe(1);
      expect(r.pass).toBe(true);
    } finally {
      e.close();
    }
  }, 120_000);
});
