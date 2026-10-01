import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Arm,
  clusteredDelta,
  DEFAULT_JEV,
  DEFAULT_LLM,
  decideEvidence,
  EVIDENCE_RULE,
  type EvidenceReport,
  evidenceCmd,
  type LiftRow,
  planCells,
  SERVED,
  twinKey,
} from '../src/evidence';
import { openLocalEngine } from '../src/local';
import type { EvalRecord } from '../src/optimize/evaluate';
import type { EvalInstance } from '../src/optimize/instances';
import { renderReport } from '../src/report';
import { runSession, SessionScript } from '../src/session';
import { importTwin } from '../src/twin';

function rec(i: number, o: Partial<EvalRecord> = {}): EvalRecord {
  return {
    candidate: 'c',
    predictorId: 'p',
    instanceId: `i${i}`,
    mimicId: `m${i % 6}`,
    split: 'test',
    type: 'choice',
    stateHash: `s${i}`,
    evidenceSeqMax: 1,
    stateTokens: 1,
    modelSnapshot: 'snap',
    ok: true,
    error: null,
    transient: false,
    dist: { a: 0.6, b: 0.4 },
    answer: 'a',
    logLoss: 0.6,
    itemAcc: 0.5,
    top1: 1,
    brier: 0.2,
    confidence: 0.6,
    baselineItemAcc: null,
    value: -0.6,
    costUsd: 0.00001,
    latencyMs: 200,
    feedback: '',
    ...o,
  };
}

const ids = Array.from({ length: 240 }, (_, i) => i);
const recs = (f: (i: number) => Partial<EvalRecord> = () => ({})) => ids.map((i) => rec(i, f(i)));

/** A lift row: `d` is the change in log loss for every question; item accuracy moves the other way. */
function row(
  dataset: string,
  predictor: string,
  view: Arm['view'],
  against: Arm['view'],
  d: number,
  people = 6,
) {
  const a = ids.map((i) => rec(i, { mimicId: `m${i % people}` }));
  const b = ids.map((i) =>
    rec(i, { mimicId: `m${i % people}`, logLoss: 0.6 + d + (i % 2 ? 0.01 : -0.01), itemAcc: 0.5 - d }),
  );
  return { dataset, predictor, view, against, identical: false, delta: clusteredDelta(a, b, 't') } as LiftRow;
}

describe('E6 analysis (ADR-0053)', () => {
  it('measures the primary as served, and the default LLM', () => {
    expect(DEFAULT_JEV).toBe(DEFAULT_CONFIG.predictor.primary);
    expect(DEFAULT_LLM).toBe('llm:deepseek/deepseek-v4.1-flash@predict.v2');
  });

  it('pairs by question, resamples people, and counts who improves', () => {
    const a = recs();
    const b = recs((i) => ({ logLoss: i % 6 === 0 ? 0.7 : 0.5, itemAcc: 0.6 }));
    const d = clusteredDelta(a, b, 'x');
    expect(d.n).toBe(240);
    expect(d.people).toBe(6);
    expect(d.better).toBe(5);
    expect(d.worse).toBe(1);
    expect(d.itemAcc.mean).toBeCloseTo(0.1);
    expect(d.logLoss.mean).toBeCloseTo((5 * -0.1 + 0.1) / 6);
    expect(d.logLoss.ciLow).toBeLessThanOrEqual(d.logLoss.mean);
    expect(d.logLoss.ciHigh).toBeGreaterThanOrEqual(d.logLoss.mean);
    // Resampling people is wider than resampling questions when people differ.
    expect(d.logLoss.ciHigh - d.logLoss.ciLow).toBeGreaterThan(
      d.logLoss.byQuestion[1] - d.logLoss.byQuestion[0],
    );
    expect(clusteredDelta(a, b, 'x')).toEqual(d);
    expect(clusteredDelta(a, [], 'x').n).toBe(0);
  });

  const jev = DEFAULT_JEV;
  const llm = DEFAULT_LLM;
  const twin = twinKey(EVIDENCE_RULE.twinK);

  it('ships a view that beats full on served questions and, where Twin can test it, on Twin', () => {
    const vsFull = [
      row(SERVED, jev, 'answers', 'full', -0.05),
      row(SERVED, jev, 'relevant', 'full', -0.08),
      row(twin, jev, 'relevant', 'full', -0.04, 40),
      row(SERVED, jev, 'derived', 'full', 0.1),
    ];
    const lift = [row(SERVED, jev, 'full', 'context', 0)];
    const v = decideEvidence(vsFull, lift, jev, llm);
    expect(v.outcome).toBe('ship');
    expect(v.ship).toBe('relevant');
    // Without Twin's replication, relevant can't ship; answers (which Twin can't test) still can.
    const w = decideEvidence(vsFull.slice(0, 2), lift, jev, llm);
    expect(w.ship).toBe('answers');
    expect(w.checks.find((c) => c.view === 'relevant' && c.dataset === twin)?.pass).toBe(false);
  });

  it('refuses a view that costs accuracy, helps too few people, or has too little data', () => {
    const costly = row(SERVED, jev, 'answers', 'full', -0.05);
    costly.delta.itemAcc.mean = -0.02;
    const lift = [row(SERVED, jev, 'full', 'context', 0)];
    expect(decideEvidence([costly], lift, jev, llm).ship).toBeNull();
    const few = row(SERVED, jev, 'answers', 'full', -0.05);
    few.delta.better = 3;
    expect(decideEvidence([few], lift, jev, llm).ship).toBeNull();
    const small = row(SERVED, jev, 'answers', 'full', -0.05, 4);
    expect(decideEvidence([small], lift, jev, llm).checks.find((c) => c.name === 'enough data')?.pass).toBe(
      false,
    );
  });

  it('names the bottleneck when no view ships', () => {
    const vsFull = [row(SERVED, jev, 'answers', 'full', 0.02)];
    const jevFlat = row(SERVED, jev, 'full', 'context', 0);
    const jevLearns = row(SERVED, jev, 'full', 'context', -0.1);
    const llmFlat = row(SERVED, llm, 'full', 'context', 0);
    const llmLearns = row(SERVED, llm, 'full', 'context', -0.1);
    const jevTwin = row(twin, jev, 'full', 'context', -0.1, 40);
    const jevTwinFlat = row(twin, jev, 'full', 'context', 0, 40);
    expect(decideEvidence(vsFull, [jevLearns], jev, llm).outcome).toBe('learns');
    expect(decideEvidence(vsFull, [jevFlat, llmLearns], jev, llm).outcome).toBe('model');
    expect(decideEvidence(vsFull, [jevFlat, llmFlat, jevTwin], jev, llm).outcome).toBe('questions');
    expect(decideEvidence(vsFull, [jevFlat, llmFlat, jevTwinFlat], jev, llm).outcome).toBe('none');
    expect(decideEvidence(vsFull, [row(SERVED, jev, 'full', 'context', 0, 3)], jev, llm).outcome).toBe(
      'insufficient',
    );
  });

  it('calls a predictor that was not measured, or measured on too little data, insufficient rather than flat', () => {
    const vsFull = [row(SERVED, jev, 'answers', 'full', 0.02)];
    const jevFlat = row(SERVED, jev, 'full', 'context', 0);
    const llmFlat = row(SERVED, llm, 'full', 'context', 0);
    const jevTwin = row(twin, jev, 'full', 'context', -0.1, 40);
    // The LLM never ran (a spend cap, or --llm none): the model can't be ruled out.
    expect(decideEvidence(vsFull, [jevFlat, jevTwin], jev, llm).outcome).toBe('insufficient');
    expect(decideEvidence(vsFull, [jevFlat, jevTwin], jev, null).outcome).toBe('insufficient');
    // The LLM learns, but on 3 people cut short by the cap: not enough to name the model.
    const llmShort = row(SERVED, llm, 'full', 'context', -0.1, 3);
    const v = decideEvidence(vsFull, [jevFlat, llmShort], jev, llm);
    expect(v.outcome).toBe('insufficient');
    expect(v.learns.find((l) => l.predictor === llm)).toMatchObject({ learns: true, enough: false });
    // No Twin data: questions and nothing can't be told apart.
    expect(decideEvidence(vsFull, [jevFlat, llmFlat], jev, llm).outcome).toBe('insufficient');
    // Jev learns on Twin, but from 2 people, whose person bootstrap has no width.
    const twinFew = row(twin, jev, 'full', 'context', -0.1, 2);
    expect(decideEvidence(vsFull, [jevFlat, llmFlat, twinFew], jev, llm).outcome).toBe('insufficient');
  });

  it('names a view to ship only with a ship outcome', () => {
    const lift = [row(SERVED, jev, 'full', 'context', 0, 3)];
    const v = decideEvidence([row(SERVED, jev, 'answers', 'full', -0.05)], lift, jev, llm);
    expect(v.checks.filter((c) => c.view === 'answers').every((c) => c.pass)).toBe(true);
    expect(v.outcome).toBe('insufficient');
    expect(v.ship).toBeNull();
  });

  it('plans the primary first, then Twin at the decision k, then the LLM, then the rest of the curve', () => {
    const inst = (id: string, mimicId: string) => ({ id, mimicId }) as EvalInstance;
    const served = [inst('s1', 'a')];
    const twinBy = new Map([
      [10, [inst('t10', 'x')]],
      [30, [inst('t30', 'x'), inst('u30', 'y')]],
    ]);
    const cells = planCells(served, twinBy, {
      jev,
      llm,
      jevViews: ['context', 'full'],
      llmViews: ['context', 'full'],
      llmPeople: 1,
      llmK: [30],
    });
    expect(cells.map((c) => `${c.dataset} ${c.predictor === jev ? 'jev' : 'llm'} ${c.view}`)).toEqual([
      'served jev context',
      'served jev full',
      'twin@30 jev context',
      'twin@30 jev full',
      'served llm context',
      'served llm full',
      'twin@30 llm context',
      'twin@30 llm full',
      'twin@10 jev context',
      'twin@10 jev full',
    ]);
    expect(cells.find((c) => c.dataset === 'twin@30' && c.predictor === llm)!.instances).toHaveLength(1);
  });
});

describe('E6 end to end, offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimic-e6-'));
  const served = join(dir, 'served.sqlite');
  const twin = join(dir, 'twin.sqlite');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeAll(async () => {
    const engine = await openLocalEngine({ db: served, providers: 'offline', seed: 'e6-cohort' });
    for (let i = 0; i < 3; i++) {
      const script = SessionScript.parse({
        intake: {
          name: `Person ${i}`,
          location: 'Porto, PT',
          occupation: 'Teacher',
          employer: 'Escola Norte',
        },
        consentResearch: true,
        policy: 'first',
        seed: `e6-${i}`,
      });
      await runSession(engine, script, { turns: 16 });
    }
    engine.close();
    const t = await openLocalEngine({ db: twin, providers: 'offline' });
    await importTwin(t.deps, { path: join(__dirname, '../fixtures/twin2k500.sample.jsonl') });
    t.close();
  }, 120_000);

  it('runs every arm on the same questions, reproduces what production saw, and renders a verdict', async () => {
    const out = join(dir, 'run');
    await evidenceCmd([
      '--data',
      `${served},${twin}`,
      '--k',
      '4,8',
      '--llm-k',
      '8',
      '--max-targets',
      '5',
      '--offline',
      '--out',
      out,
    ]);
    const engine = await openLocalEngine({ db: served, providers: 'offline' });
    const runs = await engine.deps.store.listEvalRuns();
    engine.close();
    const run = runs.find((r) => (r.spec as { kind?: string }).kind === 'evidence')!;
    const r = (run.metrics as { report: EvidenceReport }).report;
    expect(r.offline).toBe(true);
    expect(r.datasets.map((d) => d.key).sort()).toEqual([SERVED, 'twin@4', 'twin@8']);

    // Every arm of a dataset scored the same questions.
    for (const d of r.datasets) {
      const ns = new Set(r.rows.filter((x) => x.dataset === d.key).map((x) => x.n));
      expect(ns.size).toBe(1);
    }
    // The context arm sees exactly the stored baseline's state, the full arm the stored primary's.
    expect(r.checks?.context.n).toBeGreaterThan(0);
    expect(r.checks?.context.stateMatch).toBe(1);
    expect(r.checks?.full.stateMatch).toBe(1);

    // Twin people have no traits or insights: answers shows what full shows, derived what context shows.
    const twinFull = r.lift.find(
      (l) => l.dataset === 'twin@8' && l.predictor === DEFAULT_JEV && l.view === 'answers',
    );
    expect(twinFull?.identical).toBe(false);
    const sameAsFull = r.againstFull.find((l) => l.dataset === 'twin@8' && l.view === 'answers');
    expect(sameAsFull?.identical).toBe(true);
    const derived = r.lift.find(
      (l) => l.dataset === 'twin@8' && l.predictor === DEFAULT_JEV && l.view === 'derived',
    );
    expect(derived?.identical).toBe(true);

    // The LLM ran on served questions and on Twin at its k only.
    expect(r.rows.filter((x) => x.predictor === DEFAULT_LLM).map((x) => x.dataset)).not.toContain('twin@4');
    expect(r.rows.some((x) => x.predictor === DEFAULT_LLM && x.dataset === 'twin@8')).toBe(true);
    expect(r.curve.some((c) => c.dataset === SERVED)).toBe(true);
    expect(r.verdict.outcome).toBe('insufficient');

    const md = renderReport(run);
    expect(md).toContain('Offline run with fake providers');
    expect(md).toContain('## Verdict: insufficient');
    expect(md).toContain('## Reproduction checks (served questions)');
    expect(md).toContain('### What the answers add');
    expect(md).toContain('identical states');
    expect(readFileSync(join('data/reports', run.id, 'report.md'), 'utf8')).toContain('E6 asks');
    rmSync(join('data/reports', run.id), { recursive: true, force: true });
  }, 120_000);
});
