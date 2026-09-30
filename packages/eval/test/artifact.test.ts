import {
  confirmIdentity,
  createMimic,
  curateSoul,
  deleteMimic,
  draftFromScenario,
  draftSoul,
  exportMimic,
  finishIdentity,
  labOverview,
  listPlayground,
  MimicJson,
  predictPlayground,
  SoulCuration,
  searchCacheKey,
  searchCacheKeys,
  serveNext,
  submitAnswer,
  submitFeedback,
  writeSnapshot,
} from '@mimic/core';
import { schema } from '@mimic/db';
import type { MemoryBlobs, MemoryKv } from '@mimic/db/local';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

let engine: LocalEngine;
afterEach(() => engine?.close());

async function session(consentSearch: boolean, turns: number, name = 'Avery Quinn') {
  const m = await createMimic(
    engine.deps,
    {
      name,
      location: 'San Francisco, US',
      occupation: 'Software engineer',
      attestSelf: true,
      consentSearch,
      consentResearch: true,
    },
    `p-${name}`,
  );
  await engine.drain();
  if (consentSearch) {
    const [top] = await engine.deps.store.listCandidates(m.id);
    await confirmIdentity(engine.deps, m.id, top!.id);
    await engine.drain();
    await finishIdentity(engine.deps, m.id);
  }
  for (let i = 0; i < turns; i++) {
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    await engine.drain((j) => j.type !== 'snapshot.write');
    await submitAnswer(engine.deps, m.id, {
      questionId: next.question.id,
      value: next.question.options.at(-1)!.key,
      why: i === 0 ? 'a reason' : undefined,
      latencyMs: 900,
      idempotencyKey: `k-${m.id}-${i}`,
    });
    await engine.drain();
  }
  return m;
}

type Db = { all: (q: unknown) => Promise<Array<Record<string, unknown>>> };

describe('mimic artifact (M6)', () => {
  it('never overwrites a committed snapshot when two writers race for the same version', async () => {
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    const m = await session(false, 3);
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    await submitAnswer(engine.deps, m.id, {
      questionId: next.question.id,
      value: next.question.options[0]!.key,
      latencyMs: 900,
      idempotencyKey: `k-race-${m.id}`,
    });
    // Writer 1 reads the latest version, then stalls before its blob write until writer 2 has committed.
    const blobs = engine.deps.blobs;
    const put = blobs.put.bind(blobs);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let stalled = false;
    blobs.put = async (key, body, type) => {
      if (key.startsWith(`snapshots/${m.id}/`) && !stalled) {
        stalled = true;
        await gate;
      }
      return put(key, body, type);
    };
    const w1 = writeSnapshot(engine.deps, m.id).then(
      () => 'ok',
      () => 'conflict',
    );
    while (!stalled) await new Promise((r) => setTimeout(r, 5));
    const v = await writeSnapshot(engine.deps, m.id);
    const row = (await engine.deps.store.listSnapshots(m.id)).find((x) => x.version === v)!;
    const committed = await blobs.get(row.r2Key);
    release();
    expect(await w1).toBe('conflict');
    // The committed snapshot is untouched, and the loser left no blob behind.
    expect(await blobs.get(row.r2Key)).toBe(committed);
    const snaps = await engine.deps.store.listSnapshots(m.id);
    expect((await blobs.list(`snapshots/${m.id}/`)).sort()).toEqual(snaps.map((x) => x.r2Key).sort());
  }, 60_000);

  it('exports a snapshot that validates against mimic/1', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(true, 12);
    const doc = await exportMimic(engine.deps, m.id);
    expect(MimicJson.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({ schema: 'mimic/1', mimicId: m.id, seqUpTo: 12 });
    expect(doc.evidence).toHaveLength(12);
    expect(doc.facts.every((f) => f.source)).toBe(true);
    expect(doc.pipeline.models.primary).toMatch(/jev-1\.13/);
    // Snapshots are immutable and versioned.
    const again = await exportMimic(engine.deps, m.id);
    expect(again.version).toBe(doc.version);
  });

  it('hard delete removes every trace across D1, R2, the vector index and KV', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const keep = await session(false, 3, 'Rowan Ellis'); // another person's data must survive
    const m = await session(true, 12);
    await exportMimic(engine.deps, m.id);
    await draftSoul(engine.deps, m.id);
    await curateSoul(engine.deps, m.id, {
      rev: 1,
      curation: SoulCuration.parse({ notes: 'My own words.' }),
    });
    const blobs = engine.deps.blobs as MemoryBlobs;
    const kv = engine.deps.kv as MemoryKv;
    const db = (engine.deps.store as unknown as { db: Db }).db;
    const mentions = async () => {
      const rows: string[] = [];
      for (const [name, table] of Object.entries(schema)) {
        if (typeof table !== 'object' || !table || !('getSQL' in table)) continue;
        for (const r of await db.all(sql`select * from ${table}`)) {
          if (JSON.stringify(r).includes(m.id)) rows.push(name);
        }
      }
      return rows;
    };
    // Sanity: the mimic is everywhere before deletion.
    expect((await mentions()).length).toBeGreaterThan(50);
    expect([...blobs.data.keys()].some((k) => k.includes(m.id))).toBe(true);
    await kv.put(`hyp:${m.id}`, '{"seqUpTo":1,"hypotheses":[]}');
    expect(await kv.get(searchCacheKey((await engine.deps.store.getMimic(m.id))!))).not.toBeNull();
    const traceKeys = (await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 100_000 })).map(
      (c) => c.r2TraceKey,
    );
    expect(traceKeys.length).toBeGreaterThan(30);

    await deleteMimic(engine.deps, m.id);

    expect(await mentions()).toEqual([]);
    expect([...blobs.data.keys()].filter((k) => k.includes(m.id))).toEqual([]);
    for (const k of traceKeys) expect(await blobs.get(k)).toBeNull();
    for (const [, v] of blobs.data) expect(v).not.toContain(m.id);
    expect([...kv.data.keys()].filter((k) => k.includes(m.id))).toEqual([]);
    for (const k of searchCacheKeys({
      displayName: 'Avery Quinn',
      location: 'San Francisco, US',
      occupation: 'Software engineer',
      employer: null,
      links: [],
    }))
      expect(await kv.get(k)).toBeNull();
    // Deletion is scoped: the other mimic is untouched.
    expect(await engine.deps.store.getMimic(keep.id)).not.toBeNull();
    expect((await engine.deps.store.listAnswers(keep.id)).length).toBe(3);
  });

  it('stores and scores playground answers as kind = playground, outside fidelity and states', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(false, 11);
    const fidBefore = await engine.deps.store.listFidelity(m.id);
    const draft = await draftFromScenario(
      engine.deps,
      m.id,
      'A friend invites you on a last-minute weekend trip.',
    );
    expect(draft.options.length).toBeGreaterThanOrEqual(2);
    const pred = await predictPlayground(engine.deps, m.id, { ...draft, rationale: true });
    expect(pred.question.kind).toBe('playground');
    expect(Object.values(pred.dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(pred.rationale).toBeTruthy();
    const res = await submitAnswer(engine.deps, m.id, {
      questionId: pred.question.id,
      value: pred.question.options[0]!.key,
      latencyMs: 0,
      idempotencyKey: `pg-${m.id}`,
    });
    expect(res.fidelity).toBeNull();
    const q = (await engine.deps.store.getQuestion(pred.question.id))!;
    expect(q.kind).toBe('playground');
    expect(q.status).toBe('answered');
    const scored = await engine.deps.store.listScoredPredictions(m.id, ['primary', 'baseline']);
    const pgScores = scored.filter((r) => r.question.kind === 'playground');
    expect(pgScores.map((r) => r.prediction.role).sort()).toEqual(['baseline', 'primary']);
    // Separate test set: fidelity is untouched and later states never include the playground answer.
    expect(await engine.deps.store.listFidelity(m.id)).toHaveLength(fidBefore.length);
    const next = await serveNext(engine.deps, m.id);
    expect(next.status).toBe('question');
    await engine.drain((j) => j.type !== 'snapshot.write');
    const primary = (
      await engine.deps.store.listPredictions({
        questionId: (next as { question: { id: string } }).question.id,
        roles: ['primary'],
      })
    )[0]!;
    const state = await engine.deps.blobs.get(`states/${m.id}/${primary.stateHash}.json`);
    expect(state).not.toContain(pred.question.prompt);
    // Invariant 3: the export keeps the playground evidence, labeled by kind.
    const doc = await exportMimic(engine.deps, m.id);
    expect(doc.evidence.find((e) => e.kind === 'playground')).toBeDefined();
  });

  it('stores feedback the person answers themselves as learning evidence, never scored (ADR-0032)', async () => {
    // States take feedback given at least STATE_SETTLE_MS before the serve, like derived data (ADR-0017).
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    const m = await session(false, 11);
    const fidBefore = await engine.deps.store.listFidelity(m.id);
    const question = {
      type: 'choice' as const,
      prompt: 'Would you rather spend a free Saturday hiking or reading at home?',
      options: [
        { key: 'x1', label: 'Hiking in the hills' },
        { key: 'x2', label: 'Reading at home' },
        { key: 'x3', label: 'Seeing friends in town' },
      ],
    };
    const input = { question, answer: 'x2', why: 'I recharge alone', idempotencyKey: `fb-${m.id}` };
    const res = await submitFeedback(engine.deps, m.id, input);
    expect(res.question.kind).toBe('feedback');
    // Keys are renormalized by the schema gate; the pick is carried over by position.
    expect(res.answer).toEqual({ optionKey: 'b', label: 'Reading at home' });

    // Idempotent: a retry with the same key returns the same question and writes nothing new.
    const again = await submitFeedback(engine.deps, m.id, input);
    expect(again.question.id).toBe(res.question.id);
    const qs = await engine.deps.store.listQuestions(m.id);
    expect(qs.filter((q) => q.kind === 'feedback')).toHaveLength(1);
    const q = qs.find((x) => x.id === res.question.id)!;
    expect(q).toMatchObject({ status: 'answered', seq: res.question.seq, stateAt: null });
    expect(res.question.seq).toBe(Math.max(...qs.filter((x) => x.id !== q.id).map((x) => x.seq ?? 0)) + 1);
    expect((await engine.deps.store.getMimic(m.id))!.seqMax).toBe(res.question.seq);
    const a = await engine.deps.store.getAnswerForQuestion(q.id);
    expect(a).toMatchObject({ value: 'b', why: 'I recharge alone', revealedPrediction: false });

    // Nothing predicted, nothing scored, fidelity and session progress untouched.
    expect(await engine.deps.store.listPredictions({ questionId: q.id })).toEqual([]);
    const scored = await engine.deps.store.listScoredPredictions(m.id, ['primary', 'baseline']);
    expect(scored.filter((r) => r.question.id === q.id)).toEqual([]);
    expect(await engine.deps.store.listFidelity(m.id)).toHaveLength(fidBefore.length);
    const lab = await labOverview(engine.deps, { includeAll: true, population: 'all' });
    expect(lab.invariants.incomplete).toBe(0);

    // Learning runs on it, and the next sealed state includes it.
    await engine.drain((j) => j.type !== 'snapshot.write');
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    expect(next.progress.answered).toBe(11);
    expect(next.question.seq).toBe(res.question.seq + 1);
    const primary = (
      await engine.deps.store.listPredictions({ questionId: next.question.id, roles: ['primary'] })
    )[0]!;
    expect(primary.evidenceSeqMax).toBe(res.question.seq);
    const state = await engine.deps.blobs.get(`states/${m.id}/${primary.stateHash}.json`);
    expect(state).toContain(question.prompt);
    expect(state).toContain('I recharge alone');

    // History and export label it by kind.
    const hist = await listPlayground(engine.deps, m.id);
    expect(hist).toMatchObject({ taught: 1, checked: 0, matched: 0 });
    expect(hist.items[0]).toMatchObject({ question: { id: q.id }, answer: { optionKey: 'b' }, guess: null });
    const doc = await exportMimic(engine.deps, m.id);
    expect(doc.evidence.find((e) => e.kind === 'feedback')).toMatchObject({ answer: 'b' });
  });

  it('validates feedback before storing it', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(false, 1);
    const base = {
      type: 'choice' as const,
      prompt: 'Which would you order at a new cafe?',
      options: [
        { key: 'a', label: 'Espresso' },
        { key: 'b', label: 'Tea' },
      ],
    };
    const send = (question: typeof base, answer: string, k: string) =>
      submitFeedback(engine.deps, m.id, { question, answer, idempotencyKey: `fb-${k}-${m.id}` });
    await expect(send(base, 'z', 'unknown')).rejects.toThrow('Pick one of the options.');
    await expect(
      send({ ...base, options: [...base.options, { key: 'c', label: 'It depends' }] }, 'a', 'hedge'),
    ).rejects.toThrow(/can't hedge/);
    await expect(
      send({ ...base, options: [base.options[0]!, { key: 'b', label: 'espresso' }] }, 'a', 'dup'),
    ).rejects.toThrow('Two options say the same thing.');
    // Yes/no keeps its keys.
    const yn = await send(
      {
        ...base,
        type: 'noul' as never,
        prompt: 'Would you order a second coffee?',
        options: [
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ],
      },
      'no',
      'yn',
    );
    expect(yn.answer.optionKey).toBe('no');
    expect((await engine.deps.store.listQuestions(m.id)).filter((q) => q.kind === 'feedback')).toHaveLength(
      1,
    );
  });

  it('gives feedback and a concurrent serve distinct seqs', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(false, 2);
    const question = {
      type: 'choice' as const,
      prompt: 'Would you go to a concert alone?',
      options: [
        { key: 'a', label: 'Happily' },
        { key: 'b', label: 'Only with a friend' },
      ],
    };
    const [fb, next] = await Promise.all([
      submitFeedback(engine.deps, m.id, { question, answer: 'a', idempotencyKey: `fb-race-${m.id}` }),
      serveNext(engine.deps, m.id),
    ]);
    if (next.status !== 'question') throw new Error(next.status);
    expect(fb.question.seq).not.toBe(next.question.seq);
    const seqs = (await engine.deps.store.listQuestions(m.id)).map((q) => q.seq).filter((s) => s !== null);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('reports asked and taught questions, newest first, with match counts', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await session(false, 11);
    const draft = await draftFromScenario(engine.deps, m.id, 'A friend invites you on a last-minute trip.');
    const asked = await predictPlayground(engine.deps, m.id, { ...draft, rationale: false });
    const pending = await predictPlayground(engine.deps, m.id, { ...draft, rationale: false });
    await submitAnswer(engine.deps, m.id, {
      questionId: asked.question.id,
      value: asked.guess.optionKey,
      latencyMs: 0,
      idempotencyKey: `pg-h-${m.id}`,
    });
    await submitFeedback(engine.deps, m.id, {
      question: draft,
      answer: draft.options[0]!.key,
      idempotencyKey: `fb-h-${m.id}`,
    });
    const hist = await listPlayground(engine.deps, m.id);
    expect(hist.items.map((i) => i.question.kind)).toEqual(['feedback', 'playground', 'playground']);
    expect(hist.items[1]).toMatchObject({ question: { id: pending.question.id }, answer: null });
    expect(hist.items[1]!.guess).toEqual(pending.guess);
    expect(hist.items[2]).toMatchObject({ answer: { optionKey: asked.guess.optionKey } });
    expect(hist).toMatchObject({ taught: 1, checked: 1, matched: 1 });
  });
});
