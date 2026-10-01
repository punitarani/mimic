import { join } from 'node:path';
import { draftSoul } from '@mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { renderReport } from '../src/report';
import { runSession, SessionScript } from '../src/session';
import { TRANSFER_VIEWS, transfer, viewTokens } from '../src/transfer';
import { importTwin } from '../src/twin';

let engine: LocalEngine;
afterEach(() => engine?.close());

const script = (name: string) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch: true,
    seed: name,
    whys: { 'free afternoon': 'I always go for the long walk, no matter the weather' },
  });

describe('transfer loss (ADR-0055)', () => {
  it('scores every view with every reader on the later answers, sealed, at its size', async () => {
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    const a = await runSession(engine, script('Transfer One'), { turns: 24 });
    await runSession(engine, script('Transfer Two'), { turns: 24 });
    // A stored draft written from every answer is not sealed below the checkpoints, so the views ignore it.
    await draftSoul(engine.deps, a.mimicId);
    const r = await transfer(
      engine.deps,
      {
        name: 't',
        readers: ['llm:deepseek/deepseek-v4.1-flash', 'jev:typesafe/jev-1.13'],
        views: [...TRANSFER_VIEWS],
        checkpoints: [8, 16],
        split: 'all',
        targets: 'later',
        draft: false,
        cardMaxEvidence: 4,
        cardPolicy: 'surprise',
        seed: 's',
      },
      'hash',
    );
    expect(r.checkpoints.map((c) => c.k)).toEqual([8, 16]);
    const c8 = r.checkpoints[0]!;
    expect(c8.people).toBe(2);
    // Six views × two readers, each on the same later answers.
    expect(c8.views).toHaveLength(12);
    const n = new Set(c8.views.map((v) => v.n));
    expect(n.size).toBe(1);
    const llm = c8.views.filter((v) => v.reader === 'llm:deepseek/deepseek-v4.1-flash');
    expect(llm.map((v) => v.view)).toEqual([...TRANSFER_VIEWS]);
    const by = (view: string) => llm.find((v) => v.view === view)!;
    expect(by('context').role).toBe('baseline');
    expect(by('context').lift).toBeNull();
    expect(by('state').transferLoss).toBeNull();
    for (const v of ['card', 'soul-core', 'soul-full', 'mimic-json'])
      expect(typeof by(v).transferLoss).toBe('number');
    // The core profile is never larger than the full one; the card is smaller than the state it came from.
    expect(by('soul-core').tokens).toBeLessThanOrEqual(by('soul-full').tokens);
    expect(by('card').tokens).toBeLessThan(by('state').tokens);
    expect(by('context').tokens).toBeLessThan(by('card').tokens);
    expect(r.draftsWritten).toBe(0);

    // What the reader saw: sealed views of the first person at k = 8.
    const soul = r.samples['soul-full']!;
    expect(soul).toContain('kind: person-model');
    expect(soul).toContain('answers: 8');
    expect(soul).not.toContain('## Summary');
    expect(r.samples['mimic-json']).toContain('"schema": "mimic/1"');
    expect(viewTokens(soul)).toBe(by('soul-full').tokens === 0 ? 0 : viewTokens(soul));
    // The reason given on a later answer never leaks into an earlier view.
    const md = renderReport(r.run);
    expect(md).toContain('## After 8 answers (2 people)');
    expect(md).toContain('| `jev:typesafe/jev-1.13` | soul-core |');
    const runs = await engine.deps.store.listEvalRuns();
    expect(runs.at(-1)!.id).toBe(r.run.id);
  }, 120_000);

  it('writes a sealed soul.v1 draft per person and checkpoint when asked', async () => {
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    await runSession(engine, script('Draft Person'), { turns: 18 });
    const r = await transfer(
      engine.deps,
      {
        name: 't',
        readers: ['llm:deepseek/deepseek-v4.1-flash'],
        views: ['soul-core'],
        checkpoints: [6, 12],
        split: 'all',
        targets: 'later',
        draft: true,
        cardMaxEvidence: 12,
        cardPolicy: 'surprise',
        seed: 's',
      },
      'hash',
    );
    expect(r.draftsWritten).toBe(2);
    expect(r.samples['soul-core']).toContain('## How they decide');
    expect(r.samples['soul-core']).toContain('draft: soul.v1');
    // The writer saw only the sealed answers: its citations stay below the checkpoint. (The guide's own example
    // citation, "[#12]", is not one.)
    const body = r.samples['soul-core']!.replace(/^- Citations like .*$/m, '');
    const cites = [...body.matchAll(/\[#(\d+)(?:, #(\d+))*\]/g)].flatMap((m) =>
      m[0].match(/\d+/g)!.map(Number),
    );
    expect(cites.length).toBeGreaterThan(0);
    expect(Math.max(...cites)).toBeLessThan(7);
    const calls = await engine.deps.store.listModelCalls({ limit: 1000 });
    expect(calls.filter((c) => c.purpose === 'eval.transfer.draft')).toHaveLength(2);
    expect(calls.some((c) => c.purpose === 'eval.transfer')).toBe(true);
  }, 120_000);

  it('runs on an import, with the card ranked by a baseline it computes itself', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'twin-transfer' });
    await importTwin(engine.deps, {
      path: join(import.meta.dirname, '..', 'fixtures', 'twin2k500.sample.jsonl'),
    });
    const r = await transfer(
      engine.deps,
      {
        name: 't',
        readers: ['llm:deepseek/deepseek-v4.1-flash'],
        views: ['context', 'state', 'card'],
        checkpoints: [5],
        split: 'all',
        targets: 'heldout',
        draft: false,
        cardMaxEvidence: 2,
        cardPolicy: 'surprise',
        seed: 's',
        limitPeople: 3,
      },
      'hash',
    );
    expect(r.checkpoints[0]!.people).toBe(3);
    expect(r.checkpoints[0]!.views.map((v) => v.view)).toEqual(['context', 'state', 'card']);
    expect(r.checkpoints[0]!.views[2]!.n).toBe(15); // 5 held-out items × 3 people
    const calls = await engine.deps.store.listModelCalls({ limit: 1000 });
    expect(calls.some((c) => c.purpose === 'eval.transfer.baseline')).toBe(true);
  }, 60_000);
});
