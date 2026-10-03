import { deleteParticipant, type LabQuestionRow, labMimic, labMimics, setScope } from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript } from '../src/session';

let engine: LocalEngine;
const ids: Record<'alice1' | 'alice2' | 'bot', string> = { alice1: '', alice2: '', bot: '' };

const script = (name: string, consentResearch: boolean, seed: string) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch,
    seed,
  });

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'lab-mimics' });
  ids.alice1 = (
    await runSession(engine, script('Alice Ames', true, 'a1'), { turns: 12, participantId: 'p-alice' })
  ).mimicId;
  ids.alice2 = (
    await runSession(engine, script('Alice Again', false, 'a2'), { turns: 4, participantId: 'p-alice' })
  ).mimicId;
  ids.bot = (await runSession(engine, script('Bot Brown', true, 'b'), { turns: 4 })).mimicId;
}, 120_000);

afterAll(() => engine.close());

describe('/lab/mimics (ADR-0076)', () => {
  it('lists people with their mimics, labelled by population, filtered and paged', async () => {
    const all = await labMimics(engine.deps);
    expect(all.counts).toEqual({ all: 3, real: 2, scripted: 1, twin2k: 0 });
    expect(all.totalPeople).toBe(2);
    const alice = all.people.find((p) => p.participantId === 'p-alice')!;
    expect(alice.population).toBe('real');
    expect(alice.mimics.map((m) => m.id).sort()).toEqual([ids.alice1, ids.alice2].sort());
    expect(all.people.find((p) => p.participantId !== 'p-alice')!.population).toBe('scripted');

    expect(alice.ownedMimics).toBe(2);
    const a1 = alice.mimics.find((m) => m.id === ids.alice1)!;
    // Answers are counted: `seqMax` would also count a question served and not yet answered.
    expect(a1.answers).toBe((await engine.deps.store.listAnswers(ids.alice1)).length);
    expect(a1.answers).toBeGreaterThanOrEqual(12);
    expect(a1.fidelityCurve).toEqual(
      (await engine.deps.store.listFidelity(ids.alice1)).map((f) => f.fidelity),
    );
    expect(a1.fidelity).toBe(a1.fidelityCurve.at(-1));

    const real = await labMimics(engine.deps, { population: 'real' });
    expect(real.people.map((p) => p.participantId)).toEqual(['p-alice']);
    const unconsented = await labMimics(engine.deps, { consentResearch: false });
    expect(unconsented.totalMimics).toBe(1);
    expect(unconsented.people[0]!.mimics.map((m) => m.id)).toEqual([ids.alice2]);
    // Deleting the person removes the mimic the filter hides too, so the row counts it.
    expect(unconsented.people[0]!.ownedMimics).toBe(2);
    expect((await labMimics(engine.deps, { query: 'bot b' })).people[0]!.mimics[0]!.id).toBe(ids.bot);

    const byAnswers = await labMimics(engine.deps, { sort: 'answers', limit: 1 });
    expect(byAnswers.totalPeople).toBe(2);
    expect(byAnswers.people.map((p) => p.participantId)).toEqual(['p-alice']);
    expect(byAnswers.people[0]!.answers).toBe(
      (await engine.deps.store.listAnswers(ids.alice1)).length +
        (await engine.deps.store.listAnswers(ids.alice2)).length,
    );
    const second = await labMimics(engine.deps, { sort: 'answers', limit: 1, offset: 1 });
    expect(second.people.map((p) => p.population)).toEqual(['scripted']);
  });

  it("shows one mimic's questions, guesses and accuracy over time", async () => {
    const o = await labMimic(engine.deps, ids.alice1);
    expect(o.mimic.id).toBe(ids.alice1);
    expect(o.mimic.answers).toBe((await engine.deps.store.listAnswers(ids.alice1)).length);
    expect(o.siblings.map((s) => s.id)).toEqual([ids.alice2]);
    expect(o.siblings[0]!.answers).toBe((await engine.deps.store.listAnswers(ids.alice2)).length);
    expect(o.questions.map((q) => q.seq)).toEqual([...o.questions.map((q) => q.seq)].sort((a, b) => a - b));
    const answered = o.questions.filter((q) => q.answer);
    expect(answered.length).toBeGreaterThanOrEqual(12);
    for (const q of answered) {
      expect(q.prompt).toBeTruthy();
      expect(q.options.some((opt) => opt.key === q.answer!.key)).toBe(true);
    }
    expect(answered.filter((q) => q.primary && q.baseline).length).toBeGreaterThan(0);

    const primary = o.predictors.find((p) => p.role === 'primary')!;
    const curve = o.curves.find((c) => c.role === 'primary' && c.predictorId === primary.predictorId)!;
    expect(curve.points).toHaveLength(primary.n);
    expect(curve.points.at(-1)!.cumulative).toBeCloseTo(primary.accuracy, 10);
    expect(o.fidelity.length).toBeGreaterThan(0);
    expect(o.calls.length).toBeGreaterThan(0);
  });

  it("withholds what the person's scope hides: prompt, facets, options, answer and the guesses' keys", async () => {
    const d = engine.deps;
    const m = (await d.store.getMimic(ids.alice1))!;
    let hidden: LabQuestionRow[] = [];
    // Withdraw one category at a time until a served, predicted question falls out of scope.
    for (const c of m.scope.categories) {
      await setScope(d, m.id, { ...m.scope, categories: m.scope.categories.filter((x) => x !== c) });
      hidden = (await labMimic(d, m.id)).questions.filter((q) => q.hidden);
      if (hidden.some((q) => q.primary)) break;
      await setScope(d, m.id, m.scope);
    }
    expect(hidden.some((q) => q.primary)).toBe(true);
    for (const q of hidden) {
      expect(q.prompt).toBeNull();
      expect(q.options).toEqual([]);
      expect(q.facetIds).toEqual([]);
      expect(q.answer).toBeNull();
      for (const guess of [q.primary, q.baseline]) {
        if (!guess) continue;
        expect(guess.key).toBe('');
        expect(guess.label).toBe('');
      }
    }
    await setScope(d, m.id, m.scope);
  });

  it('deletes a person: every mimic they own and their participant row, nobody else', async () => {
    const participant = async () =>
      (await engine.client.execute({ sql: 'select id from participants where id = ?', args: ['p-alice'] }))
        .rows;
    expect(await participant()).toHaveLength(1);
    expect(await deleteParticipant(engine.deps, 'p-alice')).toEqual({ mimics: 2 });
    expect(await engine.deps.store.listMimics({ participantId: 'p-alice' })).toEqual([]);
    expect(await engine.deps.store.listAnswers(ids.alice1)).toEqual([]);
    expect(await participant()).toEqual([]);
    expect(await engine.deps.store.getMimic(ids.bot)).not.toBeNull();
    expect((await labMimics(engine.deps)).counts).toEqual({ all: 1, real: 0, scripted: 1, twin2k: 0 });
  });
});
