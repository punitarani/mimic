import { afterEach, describe, expect, it } from 'vitest';
import { ensembleFromStored, ensembleRun, hedgeWeights, linearPool, logPool } from '../src/ensemble';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { loadInstances } from '../src/optimize/instances';
import { replay } from '../src/replay';
import { renderReport } from '../src/report';
import { runSession, SessionScript } from '../src/session';

let engine: LocalEngine;
afterEach(() => engine?.close());

const script = (name: string) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch: true,
    seed: name,
  });

describe('pools and weights (ADR-0056)', () => {
  it('pools distributions and keeps weights normalised', () => {
    const a = { x: 0.9, y: 0.1 };
    const b = { x: 0.1, y: 0.9 };
    const lp = logPool(
      [
        { dist: a, w: 1 },
        { dist: b, w: 1 },
      ],
      ['x', 'y'],
    );
    expect(lp.x).toBeCloseTo(0.5);
    const lin = linearPool(
      [
        { dist: a, w: 3 },
        { dist: b, w: 1 },
      ],
      ['x', 'y'],
    );
    expect(lin.x).toBeCloseTo(0.7);
    // A member with no loss yet is treated like the best one; a losing member fades with eta.
    const w = hedgeWeights(
      new Map([
        ['m1', 2],
        ['m2', 0],
      ]),
      1,
      ['m1', 'm2', 'm3'],
    );
    expect(w.get('m2')).toBeCloseTo(w.get('m3')!);
    expect(w.get('m1')!).toBeLessThan(w.get('m2')!);
    expect([...w.values()].reduce((s, x) => s + x, 0)).toBeCloseTo(1);
    const flat = hedgeWeights(
      new Map([
        ['m1', 2],
        ['m2', 0],
      ]),
      0,
      ['m1', 'm2'],
    );
    expect(flat.get('m1')).toBeCloseTo(0.5);
  });
});

describe('ensembles of stored predictions (ADR-0056)', () => {
  it('scores every method on the questions the primary answered, with prequential weights', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'ensemble' });
    await runSession(engine, script('Ens One'), { turns: 16 });
    await runSession(engine, script('Ens Two'), { turns: 16 });
    const instances = await loadInstances(engine.deps, { k: 30, split: 'all', seed: 's' });
    expect(instances.length).toBeGreaterThan(20);
    const r = ensembleFromStored(instances, { name: 'e', etas: [1, 2], withBaseline: false, seed: 's' });
    expect(r.people).toBe(2);
    expect(r.instances).toBe(instances.length);
    // The default config's primary and five shadows.
    expect(r.members.length).toBe(6);
    expect(r.members).toContain('jev:typesafe/jev-1.13@jev-predict.v2');
    expect(r.methods.map((m) => m.method)).toEqual([
      'primary',
      'log-pool',
      'linear-pool',
      'hedge:1',
      'hedge-log:1',
      'hedge:2',
      'hedge-log:2',
      'oracle',
    ]);
    for (const m of r.methods) {
      expect(m.all.n).toBe(r.instances);
      expect(m.logLossDelta.n).toBe(r.instances);
    }
    const primary = r.methods[0]!;
    expect(primary.logLossDelta.mean).toBe(0);
    // The hindsight oracle never loses to the primary in log loss (the primary is one of its candidates).
    expect(r.methods.at(-1)!.all.logLoss).toBeLessThanOrEqual(primary.all.logLoss + 1e-9);
    const hedge = r.methods.find((m) => m.method === 'hedge:1')!;
    const ws = Object.values(hedge.finalWeights!);
    expect(ws.length).toBe(6);
    expect(ws.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    const withBase = ensembleFromStored(instances, { name: 'e', etas: [1], withBaseline: true, seed: 's' });
    expect(withBase.members.length).toBe(7);
    const { run } = ensembleRun(
      instances,
      { name: 'e', etas: [1], withBaseline: false, seed: 's' },
      'hash',
      1,
    );
    const md = renderReport(run);
    expect(md).toContain('| hedge-log:1 |');
    expect(md).toContain('## Final weights');
  }, 60_000);

  it('replays the evidence-view ensemble beside the main strategy', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'views' });
    await runSession(engine, script('View One'), { turns: 14 });
    const r = await replay(
      engine.deps,
      {
        name: 'views',
        predictor: 'jev:typesafe/jev-1.13',
        strategy: 'full',
        views: ['raw', 'structured', 'summary'],
        checkpoints: [6],
        split: 'all',
        targets: 'later',
        seed: 's',
      },
      'hash',
    );
    const ids = r.checkpoints[0]!.predictors.map((p) => p.predictorId);
    expect(ids).toContain('jev:typesafe/jev-1.13');
    expect(ids).toContain('jev:typesafe/jev-1.13@view:raw');
    expect(ids).toContain('jev:typesafe/jev-1.13@view:summary');
    expect(ids).toContain('jev:typesafe/jev-1.13@pool:views');
    const n = r.checkpoints[0]!.predictors.find((p) => p.predictorId === 'jev:typesafe/jev-1.13')!.n;
    expect(r.checkpoints[0]!.predictors.find((p) => p.predictorId.endsWith('pool:views'))!.n).toBe(n);
    expect(renderReport(r.run)).toContain('@pool:views');
  }, 60_000);
});
