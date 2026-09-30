import {
  createMimic,
  curateSoul,
  draftSoul,
  exportSoul,
  getSoul,
  SoulCuration,
  serveNext,
  setFactState,
  soulKey,
  submitAnswer,
} from '@mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

let engine: LocalEngine;
afterEach(() => engine?.close());

async function answer(mimicId: string, turns: number, from = 0) {
  for (let i = from; i < from + turns; i++) {
    const next = await serveNext(engine.deps, mimicId);
    if (next.status !== 'question') throw new Error(next.status);
    await engine.drain((j) => j.type !== 'snapshot.write');
    await submitAnswer(engine.deps, mimicId, {
      questionId: next.question.id,
      value: next.question.options[0]!.key,
      why: i === 1 ? 'Fast beats perfect for me' : undefined,
      latencyMs: 900,
      idempotencyKey: `k-${mimicId}-${i}`,
    });
    await engine.drain();
  }
}

async function mimic() {
  return createMimic(
    engine.deps,
    {
      name: 'Avery Quinn',
      location: 'San Francisco, US',
      occupation: 'Software engineer',
      attestSelf: true,
      consentSearch: false,
      consentResearch: true,
    },
    'p-avery',
  );
}

describe('SOUL.md (ADR-0036)', () => {
  it('drafts, curates and exports a SOUL.md from live data', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await mimic();
    await engine.drain();
    await answer(m.id, 3);
    await expect(draftSoul(engine.deps, m.id)).rejects.toThrow(/at least 5/);

    await answer(m.id, 9, 3);
    const snaps = (await engine.deps.store.listSnapshots(m.id)).length;
    const before = await getSoul(engine.deps, m.id);
    // Viewing reads live data and never writes a snapshot (it can't race snapshot.write or freeze derived data).
    expect((await engine.deps.store.listSnapshots(m.id)).length).toBe(snaps);
    expect(before.draft).toBeNull();
    expect(before.source.answers).toBe(12);
    expect(before.markdown).toContain('# SOUL.md: Avery Quinn');
    expect(before.markdown).toContain('## Key decisions');
    expect(before.markdown).toContain('Why: “Fast beats perfect for me”');
    expect(before.markdown).not.toContain('## Summary');

    const v = await draftSoul(engine.deps, m.id);
    expect(v.draft).toMatchObject({ promptVersion: 'soul.v1', seqUpTo: 12, answers: 12, newAnswers: 0 });
    expect(v.draft!.modelSnapshot).toMatch(/@fake$/);
    const statements = v.sections.filter((s) => s.items.some((i) => i.key.startsWith('st:')));
    // The fake writer returns two uncited statements; the citation guard drops them.
    expect(statements.map((s) => s.id).sort()).toEqual([
      'biases',
      'decision_style',
      'principles',
      'tensions',
      'tradeoffs',
    ]);
    expect(v.markdown).toContain('## How they decide');
    expect(v.markdown).not.toContain('must be dropped');
    const calls = await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 1000 });
    const call = calls.find((c) => c.purpose === 'soul.draft')!;
    expect(call.configHash).toBe(m.configHash);
    // No name goes to the writer (data minimization).
    expect(await engine.deps.blobs.get(call.r2TraceKey)).not.toContain('Avery');

    const st = v.sections.find((s) => s.id === 'decision_style')!.items[0]!;
    const curation = SoulCuration.parse({
      name: 'Avery',
      notes: 'I never decide on money the same day.',
      boundaries: [{ kind: 'never', text: 'Book anything before 10am.' }],
      disabled: ['tendencies'],
      hidden: [soulKey.identity('location'), 'st:gone'],
      edits: { [st.key]: 'Commits quickly, then revisits.', 'st:gone': 'stale' },
    });
    const curated = await curateSoul(engine.deps, m.id, { rev: 10, curation });
    expect(curated.curation.hidden).toEqual([soulKey.identity('location')]);
    expect(curated.curation.edits).toEqual({ [st.key]: 'Commits quickly, then revisits.' });
    expect(curated.rev).toBe(10);
    // A save that arrives late (older rev) never overwrites a newer one.
    const late = await curateSoul(engine.deps, m.id, { rev: 9, curation: { ...curation, notes: 'Old.' } });
    expect(late).toMatchObject({ rev: 10, curation: { notes: 'I never decide on money the same day.' } });
    const md = await exportSoul(engine.deps, m.id);
    expect(md).toContain('kind: person-model\nsubject: "Avery"');
    expect(md).toContain('# SOUL.md: Avery\n');
    expect(md).toContain('- Never: Book anything before 10am.');
    expect(md).toContain('## In their own words\n\n> I never decide on money the same day.');
    expect(md).toContain('- Commits quickly, then revisits.');
    expect(md).not.toContain('San Francisco');
    expect(md).not.toContain('## Measured tendencies');
    // The core profile keeps everything but the appendix.
    const core = await exportSoul(engine.deps, m.id, 'core');
    expect(core).toContain('profile: core');
    expect(core).toContain('## Key decisions');
    expect(core).not.toContain('## Appendix');
    // All 12 answers fit under "Key decisions", so there's no appendix yet.
    expect(md).not.toContain('## Appendix');

    // A removed fact leaves the file at once, with no new answer or snapshot needed.
    const fact = (await engine.deps.store.listFacts(m.id)).find((f) => f.object === 'Planning trips')!;
    expect(md).toContain('Interest: Planning trips');
    await setFactState(engine.deps, m.id, fact.id, 'removed');
    expect(await exportSoul(engine.deps, m.id)).not.toContain('Planning trips');

    // New answers mark the draft stale; the deterministic sections follow right away.
    await answer(m.id, 2, 12);
    const later = await getSoul(engine.deps, m.id);
    expect(later.draft).toMatchObject({ answers: 12, newAnswers: 2 });
    expect(later.source.answers).toBe(14);
    // Past the key-decision cap, the rest of the record moves to an appendix, which the core leaves out.
    expect(later.markdown).toContain('## Appendix: all other answers');
    expect(later.coreMarkdown).not.toContain('## Appendix');
    expect(later.markdown).toContain('**#14**');
    expect(later.markdown).toContain('- Commits quickly, then revisits.');
  }, 60_000);

  it("drafts from the page's reserve once the session has spent its share (ADR-0035)", async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await mimic();
    await engine.drain();
    await answer(m.id, 6);
    // The standard $1 cap: the session stops at $0.80, and SOUL.md drafts run to $1.
    await engine.deps.store.updateMimic(m.id, { spendUsd: 0.85 });
    expect((await serveNext(engine.deps, m.id)).status).toBe('budget');
    expect((await draftSoul(engine.deps, m.id)).draft?.promptVersion).toBe('soul.v1');
    await engine.deps.store.updateMimic(m.id, { spendUsd: 1 });
    await expect(draftSoul(engine.deps, m.id)).rejects.toMatchObject({ code: 'budget' });
  }, 60_000);
});
