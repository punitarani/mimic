import { getOntology, PROBE_V1, probeMetaOf } from '@mimic/core';
import type { MemoryBlobs } from '@mimic/db/local';
import { afterEach, describe, expect, it } from 'vitest';
import { runCohort } from '../src/cohort';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { probeReadout } from '../src/probes';
import { renderReport } from '../src/report';

let engine: LocalEngine;
afterEach(() => engine?.close());

const SENSITIVE = new Set(
  getOntology('v2')
    .filter((f) => f.sensitive)
    .map((f) => f.id),
);

describe('E7 held-out probes (ADR-0062)', () => {
  it('serves the schedule sealed, keeps shared items for their slot, and reads out without a call', async () => {
    let t = Date.now();
    engine = await openLocalEngine({
      db: ':memory:',
      providers: 'offline',
      clock: () => (t += 1_000),
      seed: 'e7',
    });
    // The E7 session target: v8's 30 answers plus the 14 probes.
    const cohort = await runCohort(engine, { preset: 'e7', people: 3, turns: 44 });
    const blobs = engine.deps.blobs as MemoryBlobs;
    const sharedSeen: string[][] = [];
    for (const { mimicId } of cohort.mimics) {
      const qs = (await engine.deps.store.listQuestions(mimicId))
        .filter((q) => q.seq !== null)
        .sort((a, b) => a.seq! - b.seq!);
      const probes = qs.filter((q) => probeMetaOf(q));
      // Every scheduled probe was served, slot by slot, and the session opens with the first shared item.
      expect(probes.map((q) => probeMetaOf(q)!.slot)).toEqual(
        PROBE_V1.slots.flatMap((s) => s.tiers.map(() => s.after)),
      );
      expect(qs[0]!.itemKey).toBe(PROBE_V1.shared[0]);
      sharedSeen.push(probes.filter((q) => probeMetaOf(q)!.tier === 'shared').map((q) => q.itemKey!));
      // The selector never asks a shared item outside its slot, and no probe touches a sensitive facet.
      expect(qs.filter((q) => !probeMetaOf(q) && PROBE_V1.shared.includes(q.itemKey ?? ''))).toEqual([]);
      for (const p of probes) expect(p.facetIds.some((f) => SENSITIVE.has(f))).toBe(false);
      // Each probe carries a sealed primary and a context-only baseline, as any served question does.
      const preds = await engine.deps.store.listPredictions({ mimicId });
      for (const p of probes) {
        const mine = preds.filter((x) => x.questionId === p.id);
        expect(mine.map((x) => x.role)).toEqual(expect.arrayContaining(['primary', 'baseline']));
        const primary = mine.find((x) => x.role === 'primary')!;
        expect(primary.evidenceSeqMax).toBeLessThan(p.seq!);
        const state = JSON.parse((await blobs.get(`states/${mimicId}/${primary.stateHash}.json`))!) as {
          evidence: Array<{ seq: number }>;
        };
        expect(state.evidence.every((e) => e.seq < p.seq!)).toBe(true);
      }
      // Repeats ask an early anchor again; the recorded load is what the person had answered on its facets.
      for (const p of probes.filter((x) => probeMetaOf(x)!.tier === 'repeat'))
        expect(qs.find((x) => x.id === probeMetaOf(p)!.sourceId)?.kind).toBe('anchor');
    }
    // The shared items are the same for everyone.
    expect(new Set(sharedSeen.map((s) => s.join('|'))).size).toBe(1);
    expect(sharedSeen[0]).toEqual(PROBE_V1.shared);

    // Scripted people are not people: the default readout sees none, `all` checks the machinery.
    const real = await probeReadout(engine.deps, { name: 'p', population: 'real', seed: 's' }, 'hash');
    expect(real.report.people).toBe(0);
    const { run, report } = await probeReadout(
      engine.deps,
      { name: 'p', population: 'all', seed: 's' },
      'hash',
    );
    expect(report.people).toBe(3);
    expect(report.probes).toBe(3 * 14);
    expect(report.rule.verdict).toBe('insufficient');
    expect(report.tiers.map((g) => g.group)).toEqual(expect.arrayContaining(['shared', 'repeat', 'far']));
    expect(report.slots).toHaveLength(PROBE_V1.slots.length);
    expect(report.repeat.n).toBe(6);
    expect(report.shadows.length).toBeGreaterThan(0);
    expect(report.insensitiveShare).not.toBeNull();
    expect(renderReport(run)).toContain('PROBE_RULE');
  }, 300_000);
});
