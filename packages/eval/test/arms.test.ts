import { describe, expect, it } from 'vitest';
import { armPerson, bootstrap, bootstrapDifference, compareArms, renderArms } from '../src/arms';

/** The arms readout's statistics on fixed numbers (ADR-0045). */

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('bootstrap intervals', () => {
  it('are seeded, and bracket the estimate', () => {
    const xs = [0.6, 0.7, 0.72, 0.75, 0.8, 0.81, 0.9];
    const a = bootstrap(xs, mean, 's');
    expect(a).toEqual(bootstrap(xs, mean, 's'));
    expect(a.n).toBe(7);
    expect(a.estimate).toBeCloseTo(mean(xs), 10);
    expect(a.low!).toBeLessThan(a.estimate!);
    expect(a.high!).toBeGreaterThan(a.estimate!);
    expect(bootstrap([], mean, 's')).toEqual({ estimate: null, low: null, high: null, n: 0 });
  });

  it('call a clear difference significant and an overlapping one not', () => {
    const low = [0.6, 0.61, 0.62, 0.63, 0.64, 0.65, 0.61, 0.62];
    const high = low.map((x) => x + 0.2);
    const clear = bootstrapDifference(low, high, mean, 'd');
    expect(clear.estimate).toBeCloseTo(0.2, 10);
    expect(clear.significant).toBe(true);
    expect(clear.low!).toBeGreaterThan(0);
    const same = bootstrapDifference(low, [...low].reverse(), mean, 'd');
    expect(same.significant).toBe(false);
    expect(same.low!).toBeLessThanOrEqual(0);
    expect(same.high!).toBeGreaterThanOrEqual(0);
    expect(bootstrapDifference([], high, mean, 'd').significant).toBe(false);
  });
});

describe('arm people and summaries', () => {
  const series = (n: number, from: number, step: number) =>
    Array.from({ length: n }, (_, i) => from + i * step);

  it("reads fidelity at 20 and questions to sustain 0.75 from a person's series", () => {
    const p = armPerson({ id: 'm1', arm: 'v8', participantId: 'script:1' }, series(24, 0.5, 0.02));
    expect(p.population).toBe('scripted');
    expect(p.answered).toBe(24);
    expect(p.fidelityAt20).toBeCloseTo(0.88, 10);
    // 0.5 + 0.02·i ≥ 0.75 from i = 13 (the 14th answer) on.
    expect(p.toSustain).toBe(14);
    const short = armPerson({ id: 'm2', arm: null, participantId: 'p' }, series(12, 0.5, 0.01));
    expect(short).toMatchObject({ arm: 'default', population: 'real', fidelityAt20: null, toSustain: null });
  });

  it('compares every arm against the control and says when a difference is not significant', () => {
    const people = [
      ...[0.5, 0.52, 0.54].map((f, i) =>
        armPerson({ id: `c${i}`, arm: 'control', participantId: `p${i}` }, series(20, f, 0.01)),
      ),
      ...[0.51, 0.53, 0.55].map((f, i) =>
        armPerson({ id: `t${i}`, arm: 'v8', participantId: `q${i}` }, series(20, f, 0.01)),
      ),
    ];
    const r = compareArms(
      people,
      new Map([
        ['control', 'cfg.e3b.control'],
        ['v8', 'cfg.default.v8'],
      ]),
    );
    expect(r.control).toBe('control');
    expect(r.arms.map((a) => [a.arm, a.people, a.fidelityAt20.n])).toEqual([
      ['control', 3, 3],
      ['v8', 3, 3],
    ]);
    expect(r.differences).toHaveLength(1);
    expect(r.differences[0]!.fidelityAt20.estimate).toBeCloseTo(0.01, 10);
    const md = renderArms({ experimentId: 'e', experimentName: 'E3b', population: 'real', ...r }).join('\n');
    expect(md).toContain('Real people only.');
    expect(md).toContain('| v8 − control |');
    expect(md).toContain('not significant');
  });
});
