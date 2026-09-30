import { ONTOLOGY_V2 } from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { renderReport } from '../src/report';
import { BY, type RubricPerson, rubricPerson, rubricRun, SHARE_BOUNDS } from '../src/rubric';
import { runSession, SessionScript } from '../src/session';

/**
 * cfg.default.v7's balance, trust ramp and sweep (ADR-0044) on offline sessions. The fakes answer by script and tag
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

describe('cfg.default.v7 on offline sessions (ADR-0044)', () => {
  it('keeps every category between 15% and 40% by question 30 with all four selected', () => {
    for (const p of people.all) {
      expect(p.config).toBe('cfg.default.v7');
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
    expect(md).toContain('scripted (not a result) · cfg.default.v7');
    expect(md).toContain('R4 sensitive by 30');
  });
});
