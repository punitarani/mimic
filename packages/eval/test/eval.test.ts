import { join } from 'node:path';
import { curateSoul, draftSoul, SoulCuration, VOI_SELECTOR, VOI_SELECTOR_V8 } from '@mimic/core';
import { schema } from '@mimic/db';
import type { MemoryBlobs } from '@mimic/db/local';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { datasetHash, scrubExport } from '../src/export';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { HELDOUT_PREFIX, replay, reproduceOnline } from '../src/replay';
import { renderReport } from '../src/report';
import { type SeriesPoint, simulateSelection } from '../src/select';
import { runSession, SessionScript } from '../src/session';
import { importTwin, parseBlocks } from '../src/twin';

let engine: LocalEngine;
afterEach(() => engine?.close());

const script = (name: string, consentResearch: boolean) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch,
    seed: name,
  });

async function cohort(n: number, turns = 22) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await runSession(engine, script(`Person ${i}`, i !== n - 1), { turns });
    ids.push(r.mimicId);
  }
  return ids;
}

describe('replay (M7)', () => {
  it('reproduces the online primary predictions from the exported data', async () => {
    // Human pacing, so derived traits and insights are old enough to enter sealed states (STATE_SETTLE_MS).
    let t = Date.now();
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', clock: () => (t += 1_000) });
    // A learn job landing after `stateAt` but before the serve reads the traits (the race seen live; ADR-0017)
    // must not leak into the served state, or replay cannot rebuild it.
    const store = engine.deps.store;
    const read = store.listTraitsAsOf.bind(store);
    let racing = true;
    store.listTraitsAsOf = async (mimicId, at, beforeSeq) => {
      if (racing) {
        const late = (await store.listTraits(mimicId)).map((tr) => ({
          ...tr,
          seqUpTo: beforeSeq - 1,
          mean: 1 - tr.mean,
          createdAt: engine.deps.clock(),
        }));
        await store.upsertTraits(late);
      }
      return read(mimicId, at, beforeSeq);
    };
    await cohort(3, 24); // two consented people
    const blobs = engine.deps.blobs as MemoryBlobs;
    expect(
      [...blobs.data.entries()].some(([k, v]) => k.startsWith('states/') && v.includes('"traits"')),
    ).toBe(true);
    racing = false;
    const r = await reproduceOnline(engine.deps, { seed: 's', name: 'repro' }, 'hash');
    expect(r.n).toBeGreaterThan(40);
    // Every sealed state is rebuilt byte for byte from evidence + versioned derived state as of serve time.
    expect(r.stateHashMatchRate).toBe(1);
    // The offline fake is deterministic, so scores match exactly; live Jev is compared within the tolerance.
    expect(r.meanAbsItemAccDelta).toBe(0);
    expect(r.argmaxAgreement).toBe(1);
    expect(r.pass).toBe(true);
    expect(renderReport(r.run)).toContain('Online reproduction');
  }, 60_000);

  it('replays checkpoints with a baseline, fidelity and across-person metrics', async () => {
    // Seeded IDs: mimic IDs fix anchor order, and so which anchors remain as shared targets at k = 2.
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'replay-cohort' });
    await cohort(6);
    const r = await replay(
      engine.deps,
      {
        name: 't',
        predictor: 'jev:typesafe/jev-1.13',
        strategy: 'full',
        checkpoints: [2, 15, 99],
        split: 'all',
        targets: 'later',
        seed: 's',
      },
      'hash',
    );
    expect(r.checkpoints.map((c) => c.k)).toEqual([2, 15]);
    // Anchors come first in a per-person order, so at k = 2 most anchors remain as shared targets.
    const c10 = r.checkpoints[0]!;
    expect(c10.people).toBe(5); // the non-consented person is excluded
    const roles = c10.predictors.map((p) => p.role);
    expect(roles).toEqual(['primary', 'baseline']);
    expect(c10.predictors[0]!.lift).not.toBeNull();
    expect(c10.fidelity).not.toBeNull();
    expect(c10.acrossPeople.items).toBeGreaterThan(0); // anchors are shared items
    const runs = await engine.deps.store.listEvalRuns();
    expect(runs[0]!.id).toBe(r.run.id);
    expect(renderReport(r.run)).toContain('After 2 answers');
  }, 60_000);

  it('builds a state per target when asked, so similarity has something to rank against', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'replay-per-target' });
    await cohort(3);
    const spec = {
      name: 'pt',
      predictor: 'decision:typesafe/jev-1.13',
      strategy: 'card' as const,
      evidencePolicy: 'similar' as const,
      maxEvidence: 3,
      checkpoints: [12, 16],
      split: 'all' as const,
      targets: 'later' as const,
      maxTargets: 4,
      seed: 's',
    };
    const shared = await replay(engine.deps, spec, 'hash');
    const own = await replay(engine.deps, { ...spec, perTarget: true, embed: true }, 'hash');
    const primary = (r: typeof own, k: number) =>
      r.rows.filter((x) => x.role === 'primary' && x.questionId.endsWith(`@${k}`));
    // At most four targets per person, the same ones at every checkpoint (later ones drop out as k grows).
    for (const r of [shared, own]) {
      expect(primary(r, 12).length).toBeLessThanOrEqual(2 * 4);
      const at16 = new Set(primary(r, 16).map((x) => x.questionId.split('@')[0]));
      for (const q of at16) expect(primary(r, 12).some((x) => x.questionId.startsWith(q ?? '?'))).toBe(true);
    }
    // Ranked against each target, the card holds different answers than the shared, recency-ranked one.
    const sharedDist = new Map(primary(shared, 12).map((x) => [x.questionId, x.logLoss]));
    expect(primary(own, 12).some((x) => sharedDist.get(x.questionId) !== x.logLoss)).toBe(true);
  }, 60_000);

  it('marks a replay failed, not empty, when every prediction fails', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'replay-fail' });
    await cohort(2);
    // What an exhausted account returns on every call.
    engine.deps.gateway.decide = async () => {
      throw new Error('HTTP 402 from openrouter.ai: Insufficient credits');
    };
    const r = await replay(
      engine.deps,
      {
        name: 'f',
        predictor: 'decision:typesafe/jev-1.13',
        strategy: 'full',
        checkpoints: [2],
        split: 'all',
        targets: 'later',
        seed: 's',
      },
      'hash',
    );
    expect(r.run.status).toBe('failed');
    expect(String(r.run.metrics?.firstError)).toContain('402');
  }, 60_000);

  it('simulates pool-restricted selection per budget', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'select-cohort' });
    await cohort(2);
    const r = await simulateSelection(
      engine.deps,
      {
        name: 's',
        selectors: [
          { label: 'entropy', selector: { type: 'entropy', lambdaCoverage: 0.3, muRedundancy: 0.5 } },
          { label: 'voi', selector: VOI_SELECTOR },
        ],
        budgets: [3, 6],
        split: 'all',
        seed: 's',
      },
      'hash',
    );
    expect(r.results.map((x) => `${x.selector}|${x.budget}`)).toEqual([
      'entropy|3',
      'entropy|6',
      'voi|3',
      'voi|6',
    ]);
    for (const x of r.results) {
      expect(x.people).toBe(1);
      expect(x.accuracy).toBeGreaterThan(0);
    }
    expect(renderReport(r.run)).toContain('| voi | 6 |');
  }, 60_000);

  it('records accuracy after every pick, questions to sustain, and a person with fewer categories (ADR-0044)', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'series-cohort' });
    await cohort(2, 26);
    const spec = {
      name: 's',
      selectors: [
        { label: 'voi', selector: VOI_SELECTOR },
        { label: 'voi-v8', selector: VOI_SELECTOR_V8 },
      ],
      budgets: [3, 6],
      split: 'all' as const,
      seed: 's',
      series: true,
    };
    const r = await simulateSelection(engine.deps, spec, 'hash');
    const series = r.run.metrics!.series as SeriesPoint[];
    expect(series.filter((p) => p.selector === 'voi').map((p) => p.k)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const p of series) expect(p.accuracy).toBeGreaterThan(0);
    // The budgets are read off the series, so both views agree.
    for (const x of r.results) {
      expect(x.people).toBe(1);
      expect(x.accuracy).toBeCloseTo(
        series.find((p) => p.selector === x.selector && p.k === x.budget)!.accuracy!,
        12,
      );
    }
    expect((r.run.metrics!.sustained as Array<{ selector: string }>).map((x) => x.selector)).toEqual([
      'voi',
      'voi-v8',
    ]);
    const md = renderReport(r.run);
    expect(md).toContain('Questions to sustain 75.0% accuracy on the rest');
    expect(md).toContain('| 6 |');

    // A budget past someone's pool doesn't drop them from the budgets they do reach.
    const long = await simulateSelection(engine.deps, { ...spec, budgets: [3, 500] }, 'hash');
    expect(long.results.find((x) => x.selector === 'voi' && x.budget === 3)!.people).toBe(1);
    expect(long.results.find((x) => x.selector === 'voi' && x.budget === 500)!.people).toBe(0);

    // As if the person had turned "Work and money" off: no work question is picked or predicted.
    const narrow = await simulateSelection(
      engine.deps,
      { ...spec, categories: ['psychology', 'values', 'life'] },
      'hash',
    );
    expect(narrow.run.spec).toMatchObject({ categories: ['psychology', 'values', 'life'] });
    expect(narrow.results.some((x) => x.people > 0)).toBe(true);
  }, 120_000);

  it('keeps the dataset hash when eval runs are recorded, and changes it when the data changes', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    await cohort(2, 12);
    const before = await datasetHash(engine.client);
    await simulateSelection(
      engine.deps,
      {
        name: 's',
        selectors: [
          { label: 'entropy', selector: { type: 'entropy', lambdaCoverage: 0.3, muRedundancy: 0.5 } },
        ],
        budgets: [2],
        split: 'all',
        seed: 's',
      },
      before,
    );
    expect(await datasetHash(engine.client)).toBe(before);
    await engine.client.execute("update answers set why = 'edited' where rowid = 1");
    expect(await datasetHash(engine.client)).not.toBe(before);
  }, 60_000);

  it('scrubs exports: consented only, no names or locations, pseudonymous IDs', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const ids = await cohort(3, 12);
    // Persona drafts are free text written from location and sourced facts; curations are the person's own words.
    for (const id of ids) {
      await draftSoul(engine.deps, id);
      await curateSoul(engine.deps, id, { rev: 1, curation: SoulCuration.parse({ notes: 'Mine.' }) });
    }
    const { dropped } = await scrubExport(engine.client, { keepIdentity: false });
    expect(dropped).toBe(1);
    for (const t of ['persona_drafts', 'persona_curations'])
      expect((await engine.client.execute(`select count(*) as n from ${t}`)).rows[0]!.n).toBe(0);
    const db = (
      engine.deps.store as unknown as { db: { all: (q: unknown) => Promise<Array<Record<string, unknown>>> } }
    ).db;
    const dump = JSON.stringify(
      await Promise.all(
        Object.values(schema)
          .filter((t) => typeof t === 'object' && t && 'getSQL' in t)
          .map((t) => db.all(sql`select * from ${t}`)),
      ),
    );
    for (const id of ids) expect(dump).not.toContain(id);
    expect(dump).not.toContain('Person 0');
    expect(dump).not.toContain('Lisbon');
    const mimics = await engine.deps.store.listMimics({});
    expect(mimics).toHaveLength(2);
    expect(mimics.every((m) => m.id.startsWith('m_') && m.consentResearch && m.split)).toBe(true);
    expect((await engine.deps.store.listAnswers(mimics[0]!.id)).length).toBe(12);
  }, 60_000);
});

describe('Twin-2K-500 importer', () => {
  const fixture = join(import.meta.dirname, '..', 'fixtures', 'twin2k500.sample.jsonl');

  it('maps MC and Matrix questions onto typed items and skips the rest', () => {
    const blocks = JSON.stringify([
      {
        ElementType: 'Block',
        Questions: [
          {
            QuestionID: 'Q1',
            QuestionText: 'Own a car?',
            QuestionType: 'MC',
            Options: ['Yes', 'No'],
            Settings: { Selector: 'SAVR' },
            Answers: { SelectedByPosition: 2 },
          },
          {
            QuestionID: 'Q2',
            QuestionText: 'Six options',
            QuestionType: 'MC',
            Options: ['1', '2', '3', '4', '5', '6'],
            Settings: { Selector: 'SAVR' },
            Answers: { SelectedByPosition: 2 },
          },
          {
            QuestionID: 'Q3',
            QuestionText: 'Multi',
            QuestionType: 'MC',
            Options: ['a', 'b'],
            Settings: { Selector: 'MAVR' },
            Answers: { SelectedByPosition: [1] },
          },
          {
            QuestionID: 'Q4',
            QuestionText: 'Rate',
            QuestionType: 'Matrix',
            Rows: ['A', 'B'],
            Columns: ['1', '2', '3', '4', '5'],
            Answers: { SelectedByPosition: [5, 1] },
          },
          { QuestionID: 'Q5', QuestionText: 'Age', QuestionType: 'TE', Answers: { Text: '30' } },
        ],
      },
    ]);
    const items = parseBlocks(blocks, 'x/');
    expect(items.map((i) => [i.itemKey, i.type, i.answer])).toEqual([
      ['x/Q1', 'noul', 'no'],
      ['x/Q4/1', 'score', '4'],
      ['x/Q4/2', 'score', '0'],
    ]);
  });

  it('imports evidence, held-out and retest items and replays on the held-out wave', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'twin-cohort' });
    const r = await importTwin(engine.deps, { path: fixture });
    expect(r.people).toBe(6);
    const [m] = await engine.deps.store.listMimics({});
    const qs = await engine.deps.store.listQuestions(m!.id);
    expect(qs.filter((q) => q.itemKey?.startsWith(HELDOUT_PREFIX) && q.kind === 'adaptive')).toHaveLength(5);
    expect(qs.filter((q) => q.kind === 'repeat')).toHaveLength(4);
    const heldoutMin = Math.min(
      ...qs.filter((q) => q.itemKey?.startsWith(HELDOUT_PREFIX)).map((q) => q.seq!),
    );
    expect(
      Math.max(...qs.filter((q) => q.itemKey?.startsWith('twin2k/w13/')).map((q) => q.seq!)),
    ).toBeLessThan(heldoutMin);
    const rep = await replay(
      engine.deps,
      {
        name: 'twin',
        predictor: 'jev:typesafe/jev-1.13',
        strategy: 'raw',
        checkpoints: [5, 9],
        split: 'all',
        targets: 'heldout',
        seed: 's',
      },
      'hash',
    );
    expect(rep.checkpoints.map((c) => c.k)).toEqual([5, 9]);
    expect(rep.checkpoints[0]!.people).toBe(6);
    expect(rep.checkpoints[0]!.predictors[0]!.n).toBe(30); // 5 held-out items × 6 people
    expect(rep.checkpoints[0]!.acrossPeople.items).toBeGreaterThan(0);
  }, 60_000);
});
