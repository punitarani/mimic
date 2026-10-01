import { scorePrediction } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import { type EvalRecord, looTemperatures, metricsOf, pairedDelta, rescaled } from '../src/optimize/evaluate';
import { E8_SETTINGS, TUNE_SETTINGS, tune } from '../src/tuning';

/** A two-option prediction: `p` on `a`; the person answered `answer`. `candidate` marks the setting it came from. */
function rec(
  setting: string,
  id: string,
  person: string,
  p: number,
  o: { type?: 'choice' | 'noul'; answer?: 'a' | 'b' } = {},
): EvalRecord {
  const type = o.type ?? 'choice';
  const [x, y] = type === 'noul' ? ['yes', 'no'] : ['a', 'b'];
  const dist = { [x!]: p, [y!]: 1 - p };
  const answer = o.answer === 'b' ? y! : x!;
  const s = scorePrediction(type, dist, answer);
  return {
    candidate: setting,
    predictorId: 'p',
    instanceId: id,
    mimicId: person,
    split: 'test',
    type,
    stateHash: `s:${id}`,
    evidenceSeqMax: 1,
    stateTokens: 1,
    modelSnapshot: 'snap',
    ok: true,
    error: null,
    transient: false,
    dist,
    answer,
    ...s,
    confidence: Math.max(p, 1 - p),
    baselineItemAcc: null,
    value: -s.logLoss,
    costUsd: 0,
    latencyMs: 1,
    feedback: '',
  };
}

/** `n` records for `person` in setting `s`, `p` on the answer. */
const person = (s: string, m: string, n: number, p: number) =>
  Array.from({ length: n }, (_, i) => rec(s, `${m}-${i}`, m, p));

describe('E8b tuning: nested leave-one-person-out (docs/MODELS.md §9)', () => {
  it('never scores a person at a setting their own answers chose', () => {
    // Five people do better with A; m5 does far better with B, enough that B wins on everyone together.
    const build = (s: string, pa: number, pb: number) => [
      ...['m0', 'm1', 'm2', 'm3', 'm4'].flatMap((m) => person(s, m, 10, s === 'A' ? pa : pb)),
      ...person(s, 'm5', 40, s === 'A' ? 0.3 : 0.9),
    ];
    const res = tune(
      new Map([
        ['A', build('A', 0.7, 0.6)],
        ['B', build('B', 0.7, 0.6)],
      ]),
      ['A', 'B'],
      [1],
    );
    expect(res.chosen.setting).toBe('B');
    const from = (m: string) => new Set(res.records.filter((r) => r.mimicId === m).map((r) => r.candidate));
    // Without m5, A wins: m5 is scored at A. Everyone else's fold includes m5, so B.
    expect(from('m5')).toEqual(new Set(['A']));
    for (const m of ['m0', 'm1', 'm2', 'm3', 'm4']) expect(from(m)).toEqual(new Set(['B']));
    expect(res.agree).toBe(5);
    expect(res.people).toBe(6);
    // The in-sample score is the optimistic one.
    const inSample = res.scores.find((x) => x.config === res.chosen)!.logLoss;
    expect(metricsOf(res.records).logLoss).toBeGreaterThan(inSample);
  });

  it('breaks a tie toward the earlier setting and one temperature, and keeps every instance once', () => {
    const a = ['m0', 'm1', 'm2'].flatMap((m) => person('A', m, 6, 0.65));
    const dup = a.map((r) => ({ ...r, candidate: 'B' }));
    const res = tune(
      new Map([
        ['B', dup],
        ['A', a],
      ]),
      ['A', 'B'],
    );
    expect(res.chosen).toEqual({ setting: 'A', calibration: 'one' });
    expect(res.records.every((r) => r.candidate === 'A')).toBe(true);
    expect(res.records.map((r) => r.instanceId).sort()).toEqual(a.map((r) => r.instanceId).sort());
    // One setting at one temperature is E8's leave-one-person-out calibration exactly.
    const loo = looTemperatures(a);
    expect(metricsOf(res.records).logLoss).toBeCloseTo(
      metricsOf(a.map((r) => rescaled(r, loo.byPerson.get(r.mimicId)!))).logLoss,
      12,
    );
  });

  it('fits a temperature per question type only when the types need different ones', () => {
    // Yes/no answers are overconfident (0.9 on a 60% hit rate), choices underconfident (0.6 on a 90% hit rate).
    const mixed = ['m0', 'm1', 'm2', 'm3'].flatMap((m) =>
      Array.from({ length: 20 }, (_, i) =>
        i < 10
          ? rec('A', `${m}-n${i}`, m, 0.9, { type: 'noul', answer: i < 6 ? 'a' : 'b' })
          : rec('A', `${m}-c${i}`, m, 0.6, { answer: i < 19 ? 'a' : 'b' }),
      ),
    );
    const split = tune(new Map([['A', mixed]]), ['A']);
    expect(split.chosen.calibration).toBe('type');
    const one = split.scores.find((x) => x.config.calibration === 'one')!.logLoss;
    expect(metricsOf(split.records).logLoss).toBeLessThan(one);

    // The same miscalibration in both types: the per-type fits equal the single one, so the tie keeps one temperature.
    const alike = ['m0', 'm1', 'm2', 'm3'].flatMap((m) =>
      Array.from({ length: 20 }, (_, i) =>
        rec('A', `${m}-${i}`, m, 0.9, { type: i < 10 ? 'noul' : 'choice', answer: i % 10 < 6 ? 'a' : 'b' }),
      ),
    );
    expect(tune(new Map([['A', alike]]), ['A']).chosen.calibration).toBe('one');
  });

  it('refuses settings that scored different instances', () => {
    expect(() =>
      tune(
        new Map([
          ['A', person('A', 'm0', 3, 0.6)],
          ['B', person('B', 'm0', 2, 0.6)],
        ]),
        ['A', 'B'],
      ),
    ).toThrow(/other instances/);
  });

  it('widens the interval as its tail shrinks, for the family-wise check', () => {
    const a = ['m0', 'm1', 'm2'].flatMap((m) => person('A', m, 30, 0.6));
    const b = a.map((r, i) => rec('B', r.instanceId, r.mimicId, i % 3 ? 0.7 : 0.4));
    const ninety = pairedDelta(a, b, 'logLoss', 's', 2000);
    const family = pairedDelta(a, b, 'logLoss', 's', 2000, 0.05 / 4);
    expect(family.mean).toBe(ninety.mean);
    expect(family.ciLow).toBeLessThan(ninety.ciLow);
    expect(family.ciHigh).toBeGreaterThan(ninety.ciHigh);
  });

  it('pre-registers E8 first, and a grid with no duplicates', () => {
    expect(TUNE_SETTINGS.slice(0, 2)).toEqual(E8_SETTINGS);
    expect(new Set(TUNE_SETTINGS.map((s) => s.key)).size).toBe(TUNE_SETTINGS.length);
    expect(new Set(TUNE_SETTINGS.map((s) => `${s.view}|${s.request}`)).size).toBe(TUNE_SETTINGS.length);
  });
});
