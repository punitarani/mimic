import {
  beliefFromLoaded,
  facetsFor,
  loadConfig,
  loadMimicData,
  ONTOLOGY_V2,
  visibleScoredAnswers,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scrubExport } from '../src/export';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { renderReport } from '../src/report';
import { BY, type RubricPerson, rubricPerson, rubricRun, SHARE_BOUNDS } from '../src/rubric';
import { runSession, SessionScript } from '../src/session';

/**
 * cfg.default.v8's balance, trust ramp and sweep (ADR-0044), which v9 keeps, on offline sessions. The fakes answer by script and tag
 * whatever they are asked to target, so this tests the mechanism, never how well it works for people.
 */

let engine: LocalEngine;
let t = Date.now();
const ALL = { politics: true, religion: true, sexuality: true, health: true, money: true };
const people: Record<'all' | 'noPsychology', RubricPerson[]> = { all: [], noPsychology: [] };
const byId = new Map(ONTOLOGY_V2.map((f) => [f.id, f]));

const script = (name: string, categories?: string[]) =>
  SessionScript.parse({
    intake: { name, location: 'Porto, PT', occupation: 'Teacher' },
    consentResearch: true,
    seed: name,
    consents: ALL,
    ...(categories ? { categories } : {}),
  });

beforeAll(async () => {
  engine = await openLocalEngine({
    db: ':memory:',
    providers: 'offline',
    seed: 'm12',
    clock: () => (t += 1_000),
  });
  for (const name of ['Ana', 'Ben']) {
    const { mimicId } = await runSession(engine, script(name), { turns: 32 });
    people.all.push(await rubricPerson(engine.deps, (await engine.deps.store.getMimic(mimicId))!));
  }
  const { mimicId } = await runSession(engine, script('Cy', ['values', 'life', 'work']), { turns: 32 });
  people.noPsychology.push(await rubricPerson(engine.deps, (await engine.deps.store.getMimic(mimicId))!));
}, 240_000);

afterAll(() => engine.close());

describe('the default config (v8 selection) on offline sessions (ADR-0044)', () => {
  it('keeps every category between 15% and 40% by question 30 with all four selected', () => {
    for (const p of people.all) {
      expect(p.config).toBe('cfg.default.v9');
      expect(p.sharesInBounds).toBe(true);
      for (const s of Object.values(p.shares)) {
        expect(s).toBeGreaterThanOrEqual(SHARE_BOUNDS.min);
        expect(s).toBeLessThanOrEqual(SHARE_BOUNDS.max);
      }
    }
  });

  it('reaches every consented sensitive facet by question 30 and every facet group by 20', () => {
    for (const p of [...people.all, ...people.noPsychology]) {
      expect(p.sensitiveInScope).toBe(11);
      expect(p.sensitiveMissing).toEqual([]);
      expect(p.groupsMissing).toEqual([]);
    }
  });

  it('asks nothing sensitive in the first five, even with fewer anchors, and nothing from a category turned off', async () => {
    for (const p of [...people.all, ...people.noPsychology]) {
      expect(p.sensitiveEarly).toBe(0);
      expect(p.firstSensitiveSeq).toBeGreaterThan(BY.early);
    }
    const [cy] = people.noPsychology;
    const served = (await engine.deps.store.listQuestions(cy!.mimicId)).filter((q) => q.seq !== null);
    expect(served.length).toBeGreaterThan(30);
    for (const q of served) for (const f of q.facetIds) expect(byId.get(f)?.category).not.toBe('psychology');
    // With psychology off only three anchors are seeded, so the ramp, not the anchors, holds sensitive questions back.
    expect(served.filter((q) => q.kind === 'anchor').length).toBeLessThan(5);
  });

  it('records the balance and sweep terms on every adaptive selection', async () => {
    const qs = await engine.deps.store.listQuestions(people.all[0]!.mimicId);
    const picked = qs.filter(
      (q) => q.kind === 'adaptive' && q.seq !== null && q.selection?.selector === 'voi',
    );
    expect(picked.length).toBeGreaterThan(10);
    for (const q of picked) {
      expect(typeof q.selection!.category).toBe('number');
      expect(typeof q.selection!.group).toBe('number');
      expect(typeof q.selection!.sweep).toBe('number');
    }
    expect(picked.some((q) => q.selection!.sweep === 1)).toBe(true);
  });

  it('reports the rubric by population, labelling scripted sessions', async () => {
    const { run, groups } = await rubricRun(engine.deps, { name: 'rubric' }, 'hash');
    expect(groups.map((g) => g.population)).toEqual(['scripted']);
    expect(groups[0]!.people).toBe(3);
    const md = renderReport(run);
    expect(md).toContain('scripted (not a result) · cfg.default.v9');
    expect(md).toContain('R4 sensitive by 30');
  });

  it("counts the waiting anchors in the first batch's category quota, so it leans away from psychology", async () => {
    const calls = (await engine.deps.store.listModelCalls({ mimicId: people.all[0]!.mimicId, limit: 10_000 }))
      .filter((c) => c.purpose === 'pool.generate')
      .sort((a, b) => a.createdAt - b.createdAt);
    const trace = JSON.parse((await engine.deps.blobs.get(calls[0]!.r2TraceKey))!) as {
      request: { messages: Array<{ content: string }> };
    };
    const quota = JSON.parse(trace.request.messages[1]!.content.match(/Category quota: (.*)/)![1]!) as Record<
      string,
      number
    >;
    // Seven of the ten anchors are psychology: at intake it is the only category not behind.
    expect(quota.psychology).toBeLessThan(Math.min(quota.values!, quota.life!, quota.work!));
  });

  it('the trust ramp counts answers exactly as the belief state does', async () => {
    for (const p of [...people.all, ...people.noPsychology]) {
      const m = (await engine.deps.store.getMimic(p.mimicId))!;
      const cfg = await loadConfig(engine.deps, m.configHash);
      const loaded = await loadMimicData(engine.deps, m);
      const belief = beliefFromLoaded(loaded, await facetsFor(engine.deps, m, cfg), cfg, {
        insights: [],
        scored: [],
      });
      expect(visibleScoredAnswers(loaded).length).toBe(belief.person.nAnswered);
    }
  });

  it('still labels scripted people after a research export pseudonymises their IDs', async () => {
    await scrubExport(engine.client, { keepIdentity: false });
    const { groups } = await rubricRun(engine.deps, { name: 'rubric after export' }, 'hash');
    expect(groups.map((g) => g.population)).toEqual(['scripted']);
    const [m] = await engine.deps.store.listMimics({ consentResearch: true });
    expect(m!.participantId).toMatch(/^script:p_/);
  });
});
