import {
  confirmIdentity,
  createMimic,
  deleteMimic,
  draftFromScenario,
  exportMimic,
  finishIdentity,
  MimicJson,
  predictPlayground,
  searchCacheKey,
  serveNext,
  submitAnswer,
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
    await kv.put('hyp:' + m.id, '{"seqUpTo":1,"hypotheses":[]}');
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
    expect(
      await kv.get(
        searchCacheKey({
          displayName: 'Avery Quinn',
          location: 'San Francisco, US',
          occupation: 'Software engineer',
        }),
      ),
    ).toBeNull();
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
});
