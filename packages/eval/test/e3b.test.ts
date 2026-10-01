import {
  createMimic,
  DEFAULT_CONFIG_V8_LABEL,
  E3B_CONTROL_LABEL,
  EngineError,
  EXPERIMENT_PRESETS,
  labOverview,
  ONTOLOGY_V2,
  setupPreset,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armsRun, renderArms } from '../src/arms';
import { runCohort } from '../src/cohort';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { renderReport } from '../src/report';
import { rubricRun } from '../src/rubric';

/**
 * E3b (ADR-0045): the preset, a scripted cohort in both arms, the real-people-only lab, and the arms readout. Offline
 * fakes: this checks which arm asks what and when, never how well either predicts.
 */

let engine: LocalEngine;
let cohort: Awaited<ReturnType<typeof runCohort>>;
let t = Date.now();
const SENSITIVE = new Set(ONTOLOGY_V2.filter((f) => f.sensitive).map((f) => f.id));
const PEOPLE = 2;
const TURNS = 24;

beforeAll(async () => {
  engine = await openLocalEngine({
    db: ':memory:',
    providers: 'offline',
    seed: 'e3b',
    clock: () => (t += 1_000),
  });
  cohort = await runCohort(engine, { preset: 'e3b', people: PEOPLE, turns: TURNS });
}, 240_000);

afterAll(() => engine.close());

describe('the E3b preset', () => {
  it('registers both configs and saves one draft, idempotently, never starting it', async () => {
    const fresh = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'preset' });
    try {
      const a = await setupPreset(fresh.deps, 'e3b');
      expect(a.created).toBe(true);
      expect(a.experiment.status).toBe('draft');
      expect(a.experiment.name).toBe(EXPERIMENT_PRESETS.e3b.name);
      expect(a.experiment.arms.map((x) => x.arm)).toEqual(['control', 'v8']);
      const labels = new Map((await fresh.deps.store.listConfigs()).map((c) => [c.hash, c.label]));
      expect(a.experiment.arms.map((x) => labels.get(x.configHash))).toEqual([
        E3B_CONTROL_LABEL,
        DEFAULT_CONFIG_V8_LABEL,
      ]);
      const b = await setupPreset(fresh.deps, 'e3b');
      expect(b.created).toBe(false);
      expect(b.experiment.id).toBe(a.experiment.id);
      const all = await fresh.deps.store.listExperiments();
      expect(all).toHaveLength(1);
      expect(all[0]!.status).toBe('draft');
      await expect(setupPreset(fresh.deps, 'nope')).rejects.toBeInstanceOf(EngineError);
    } finally {
      fresh.close();
    }
  });

  it('runs every persona in both arms, each under its arm config', async () => {
    expect(cohort.mimics).toHaveLength(PEOPLE * 2);
    const exp = (await engine.deps.store.listExperiments()).find((e) => e.id === cohort.experimentId)!;
    expect(exp.status).toBe('active');
    for (const x of cohort.mimics) {
      const m = (await engine.deps.store.getMimic(x.mimicId))!;
      expect(m.experimentId).toBe(exp.id);
      expect(m.arm).toBe(x.arm);
      expect(m.configHash).toBe(exp.arms.find((a) => a.arm === x.arm)!.configHash);
      expect(m.participantId.startsWith('script:')).toBe(true);
    }
    const arms = cohort.mimics.map((x) => x.arm);
    expect(arms.filter((a) => a === 'control')).toHaveLength(PEOPLE);
    expect(arms.filter((a) => a === 'v8')).toHaveLength(PEOPLE);
    // Joining an arm needs an active experiment that has it.
    await expect(
      createMimic(
        engine.deps,
        { name: 'X', location: 'Y', attestSelf: true, consentSearch: false, consentResearch: false },
        'script:x',
        { arm: 'treatment' },
      ),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('differs only by M12: balance terms in v8, none in the control; the trust ramp in both', async () => {
    for (const x of cohort.mimics) {
      const qs = (await engine.deps.store.listQuestions(x.mimicId)).filter(
        (q) => q.seq !== null && q.status !== 'discarded',
      );
      expect(qs.length).toBeGreaterThanOrEqual(TURNS - 1);
      const picked = qs.filter((q) => q.kind === 'adaptive' && q.selection?.selector === 'voi');
      expect(picked.length).toBeGreaterThan(5);
      for (const q of picked) {
        if (x.arm === 'v8') expect(typeof q.selection!.category).toBe('number');
        else {
          expect(q.selection!.category).toBeUndefined();
          expect(q.selection!.group).toBeUndefined();
          expect(q.selection!.sweep ?? 0).toBe(0);
        }
      }
      // Nothing sensitive before six answers, in either arm.
      for (const q of qs) if (q.facetIds.some((f) => SENSITIVE.has(f))) expect(q.seq!).toBeGreaterThan(6);
    }
  });
});

describe('real people only (ADR-0045)', () => {
  it('keeps scripted people out of the lab unless asked for', async () => {
    const real = await labOverview(engine.deps, { experimentId: cohort.experimentId });
    expect(real.population).toBe('real');
    expect(real.mimics).toBe(0);
    expect(real.arms).toEqual([]);
    const all = await labOverview(engine.deps, { experimentId: cohort.experimentId, population: 'all' });
    expect(all.mimics).toBe(PEOPLE * 2);
    expect(all.arms.map((a) => [a.arm, a.mimics])).toEqual([
      ['control', PEOPLE],
      ['v8', PEOPLE],
    ]);
  });

  it('reads the arms with intervals, and labels anything but real people', async () => {
    const none = await armsRun(engine.deps, { name: 'arms' }, 'hash');
    expect(none.people).toEqual([]);
    const { run, report, people } = await armsRun(engine.deps, { name: 'arms', population: 'all' }, 'hash');
    expect(report.experimentId).toBe(cohort.experimentId);
    expect(people).toHaveLength(PEOPLE * 2);
    expect(report.control).toBe('control');
    expect(report.arms.map((a) => [a.arm, a.config, a.people])).toEqual([
      ['control', E3B_CONTROL_LABEL, PEOPLE],
      ['v8', DEFAULT_CONFIG_V8_LABEL, PEOPLE],
    ]);
    for (const a of report.arms) {
      expect(a.fidelityAt20.n).toBe(PEOPLE);
      expect(a.fidelityAt20.low!).toBeLessThanOrEqual(a.fidelityAt20.estimate!);
      expect(a.fidelityAt20.high!).toBeGreaterThanOrEqual(a.fidelityAt20.estimate!);
    }
    expect(report.differences.map((d) => `${d.arm}-${d.control}`)).toEqual(['v8-control']);
    const md = renderReport(run);
    expect(md).toContain('not a result');
    expect(md).toContain('v8 − control');
    expect(renderArms({ ...report, population: 'real' }).join('\n')).toContain('Real people only.');
  });

  it('reports the rubric by arm for the same cohort', async () => {
    const { groups } = await rubricRun(engine.deps, { name: 'rubric', byArm: true }, 'hash');
    expect(groups.map((g) => `${g.population} ${g.arm}`).sort()).toEqual(['scripted control', 'scripted v8']);
  });
});
