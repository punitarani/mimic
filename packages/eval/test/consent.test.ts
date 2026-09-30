import {
  declineQuestion,
  EngineError,
  ONTOLOGY_V2,
  type QuestionRecord,
  serveNext,
  setScope,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { continueSession, runSession, SessionScript } from '../src/session';

/**
 * Confirmed consent and "Prefer not to say" (ADR-0050, resolving ADR-0049) on offline sessions under cfg.default.v8.
 * A special-category area left at intake's pre-ticked default is stored but never asked about until the person
 * confirms it; a sensitive question can be declined, and its facet is then never asked about again.
 */

let engine: LocalEngine;
let t = Date.now();
const ALL = { politics: true, religion: true, sexuality: true, health: true, money: true };
const AREA = new Map(ONTOLOGY_V2.filter((f) => f.sensitive).map((f) => [f.id, f.sensitive!]));
const SPECIAL = new Set(['politics', 'religion', 'sexuality', 'health']);
const isSpecial = (q: Pick<QuestionRecord, 'facetIds'>) =>
  q.facetIds.some((f) => SPECIAL.has(AREA.get(f) ?? ''));
const ids = { preTicked: '', confirmedLater: '', decliner: '' };
let confirmedAt = 0;

const script = (name: string, confirmed?: Record<string, boolean>) =>
  SessionScript.parse({
    intake: { name, location: 'Porto, PT', occupation: 'Teacher' },
    consentResearch: true,
    seed: name,
    consents: ALL,
    ...(confirmed ? { confirmed } : {}),
  });

async function served(id: string) {
  return (await engine.deps.store.listQuestions(id)).filter(
    (q) => q.seq !== null && q.status !== 'discarded',
  );
}

beforeAll(async () => {
  engine = await openLocalEngine({
    db: ':memory:',
    providers: 'offline',
    seed: 'consent',
    clock: () => (t += 1_000),
  });
  // Left every box pre-ticked at intake and never confirmed.
  ids.preTicked = (await runSession(engine, script('Pat', {}), { turns: 32 })).mimicId;
  // Confirms politics and health after twelve answers.
  const later = script('Lee', {});
  ids.confirmedLater = (await runSession(engine, later, { turns: 12 })).mimicId;
  const m = (await engine.deps.store.getMimic(ids.confirmedLater))!;
  confirmedAt = m.seqMax;
  await setScope(engine.deps, m.id, { ...m.scope, confirmed: { politics: true, health: true } });
  await continueSession(engine, m.id, later, { turns: 20 });
  // Confirms everything by script, and will decline a sensitive question.
  ids.decliner = (await runSession(engine, script('Dee'), { turns: 16 })).mimicId;
}, 240_000);

afterAll(() => engine.close());

describe('confirmed consent for special categories (ADR-0050)', () => {
  it('never asks about a special-category area left pre-ticked, but does ask about money', async () => {
    const qs = await served(ids.preTicked);
    expect(qs.length).toBeGreaterThan(30);
    expect(qs.filter(isSpecial)).toEqual([]);
    expect(qs.some((q) => q.facetIds.some((f) => AREA.get(f) === 'money'))).toBe(true);
    // Nor does the generator see them as askable.
    const calls = (await engine.deps.store.listModelCalls({ mimicId: ids.preTicked, limit: 10_000 })).filter(
      (c) => c.purpose === 'pool.generate',
    );
    for (const c of calls) {
      const trace = JSON.parse((await engine.deps.blobs.get(c.r2TraceKey))!) as {
        request: { messages: Array<{ content: string }> };
      };
      const user = trace.request.messages.at(-1)!.content;
      const allowed = user.match(/Sensitive facets you may ask about: (.*)/)?.[1] ?? '';
      for (const f of allowed.split(', ')) expect(SPECIAL.has(AREA.get(f) ?? '')).toBe(false);
    }
  });

  it('asks about an area once it is confirmed, without hiding anything already learned', async () => {
    const m = (await engine.deps.store.getMimic(ids.confirmedLater))!;
    expect(m.scope.confirmed).toEqual({ politics: true, health: true });
    expect(m.scopeAt).toBeNull();
    const qs = await served(ids.confirmedLater);
    expect(qs.filter((q) => isSpecial(q) && q.seq! <= confirmedAt)).toEqual([]);
    const after = qs.filter((q) => isSpecial(q) && q.seq! > confirmedAt);
    expect(after.length).toBeGreaterThan(0);
    for (const q of after)
      for (const f of q.facetIds)
        if (SPECIAL.has(AREA.get(f) ?? '')) expect(['politics', 'health']).toContain(AREA.get(f));
  });
});

describe('"Prefer not to say" (ADR-0050)', () => {
  it('discards the question unanswered and never asks about that facet again', async () => {
    const d = engine.deps;
    const script_ = script('Dee');
    // Answer until a sensitive question is served, then decline it.
    let next = await serveNext(d, ids.decliner);
    for (let i = 0; i < 20 && next.status === 'question' && !next.question.sensitive; i++) {
      await continueSession(engine, ids.decliner, script_, { turns: 1 });
      next = await serveNext(d, ids.decliner);
    }
    expect(next.status).toBe('question');
    if (next.status !== 'question') return;
    expect(next.question.sensitive).toBe(true);
    const q = (await d.store.getQuestion(next.question.id))!;
    const before = (await d.store.getMimic(ids.decliner))!;
    const change = await declineQuestion(d, ids.decliner, q.id);
    const facets = q.facetIds.filter((f) => AREA.has(f));
    expect(change.scope.declined).toEqual(expect.arrayContaining(facets));
    expect(change.discarded).toBeGreaterThanOrEqual(1);
    expect((await d.store.getQuestion(q.id))!.status).toBe('discarded');
    expect(await d.store.getAnswerForQuestion(q.id)).toBeFalsy();
    // Nobody had answered on that facet, so nothing learned is hidden and every sealed state stays replayable.
    expect(change.scopeAt).toBe(before.scopeAt);
    // Declining again is a no-op; a question on no sensitive facet can't be declined.
    expect((await declineQuestion(d, ids.decliner, q.id)).discarded).toBe(0);
    await continueSession(engine, ids.decliner, script_, { turns: 12 });
    const later = (await served(ids.decliner)).filter((x) => x.seq! > q.seq!);
    expect(later.length).toBeGreaterThan(5);
    for (const x of later) for (const f of facets) expect(x.facetIds).not.toContain(f);
    const plain = later.find((x) => x.status === 'answered' && !x.facetIds.some((f) => AREA.has(f)))!;
    await expect(declineQuestion(d, ids.decliner, plain.id)).rejects.toBeInstanceOf(EngineError);
  });

  it('can be undone from Topics and consent', async () => {
    const m = (await engine.deps.store.getMimic(ids.decliner))!;
    expect(m.scope.declined?.length).toBeGreaterThan(0);
    const change = await setScope(engine.deps, m.id, { ...m.scope, declined: [] });
    expect(change.scope.declined).toBeUndefined();
    // A request that omits the new fields keeps them (an older client can't clear them by accident).
    const again = await setScope(engine.deps, m.id, { ...m.scope, declined: ['political_leaning'] });
    const { declined: _d, confirmed: _c, ...legacy } = again.scope;
    const kept = await setScope(engine.deps, m.id, legacy);
    expect(kept.scope.declined).toEqual(['political_leaning']);
    expect(kept.scope.confirmed).toEqual(again.scope.confirmed);
  });
});
