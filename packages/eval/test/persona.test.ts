import {
  createMimic,
  curatePersona,
  draftPersona,
  exportPersona,
  getPersona,
  personaKey,
  serveNext,
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

describe('Persona.md (ADR-0027)', () => {
  it('drafts, curates and exports a persona from the latest snapshot', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await mimic();
    await engine.drain();
    await answer(m.id, 3);
    await expect(draftPersona(engine.deps, m.id)).rejects.toThrow(/at least 5/);

    await answer(m.id, 9, 3);
    const before = await getPersona(engine.deps, m.id);
    expect(before.draft).toBeNull();
    expect(before.snapshot.answers).toBe(12);
    expect(before.markdown).toContain('# Persona: Avery Quinn');
    expect(before.markdown).toContain('## Decision record');
    expect(before.markdown).toContain('Why: “Fast beats perfect for me”');
    expect(before.markdown).not.toContain('## Summary');

    const v = await draftPersona(engine.deps, m.id);
    expect(v.draft).toMatchObject({ promptVersion: 'persona.v1', seqUpTo: 12, newAnswers: 0 });
    expect(v.draft!.modelSnapshot).toMatch(/@fake$/);
    const statements = v.sections.filter((s) => s.items.some((i) => i.key.startsWith('st:')));
    // The fake writer returns two uncited statements; the citation guard drops them.
    expect(statements.map((s) => s.id).sort()).toEqual([
      'biases',
      'decision_style',
      'principles',
      'tradeoffs',
    ]);
    expect(v.markdown).toContain('## How they decide');
    expect(v.markdown).not.toContain('must be dropped');
    const calls = await engine.deps.store.listModelCalls({ mimicId: m.id, limit: 1000 });
    const call = calls.find((c) => c.purpose === 'persona.draft')!;
    expect(call.configHash).toBe(m.configHash);
    // No name goes to the writer (data minimization).
    expect(await engine.deps.blobs.get(call.r2TraceKey)).not.toContain('Avery');

    const st = v.sections.find((s) => s.id === 'decision_style')!.items[0]!;
    const curated = await curatePersona(engine.deps, m.id, {
      name: 'Avery',
      notes: 'I never decide on money the same day.',
      disabled: ['tendencies'],
      hidden: [personaKey.identity('location'), 'ex:9999'],
      edits: { [st.key]: 'Commits quickly, then revisits.' },
    });
    expect(curated.curation.hidden).toEqual([personaKey.identity('location')]);
    const md = await exportPersona(engine.deps, m.id);
    expect(md).toContain('# Persona: Avery\n');
    expect(md).toContain('## In their own words\n\nI never decide on money the same day.');
    expect(md).toContain('- Commits quickly, then revisits.');
    expect(md).not.toContain('San Francisco');
    expect(md).not.toContain('## Measured tendencies');

    // New answers mark the draft stale; the deterministic sections follow the new snapshot right away.
    await answer(m.id, 2, 12);
    const later = await getPersona(engine.deps, m.id);
    expect(later.draft!.newAnswers).toBe(2);
    expect(later.snapshot.answers).toBe(14);
    expect(later.markdown).toContain('**#14**');
    expect(later.markdown).toContain('- Commits quickly, then revisits.');
  }, 60_000);
});
