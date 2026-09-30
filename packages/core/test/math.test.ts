import { describe, expect, it } from 'vitest';
import {
  answerToDistribution,
  argmax,
  canonicalJson,
  computeFidelity,
  configHash,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_V3,
  entropy,
  expectedCalibrationError,
  gateFailures,
  normalizeDist,
  normalizedEntropy,
  type PipelineConfig,
  repeatAgreement,
  scorePrediction,
  selfConsistency,
  sha256Hex,
  ulid,
  ulidTime,
  unitHash,
} from '../src';

describe('scoring (PLAN §9.7)', () => {
  it('scores a choice prediction', () => {
    const s = scorePrediction('choice', { a: 0.7, b: 0.2, c: 0.1 }, 'a');
    expect(s.top1).toBe(1);
    expect(s.itemAcc).toBe(1);
    expect(s.logLoss).toBeCloseTo(-Math.log(0.7), 12);
    expect(s.brier).toBeCloseTo(0.3 ** 2 + 0.2 ** 2 + 0.1 ** 2, 12);
  });

  it('scores a miss', () => {
    const s = scorePrediction('noul', { yes: 0.8, no: 0.2 }, 'no');
    expect(s.top1).toBe(0);
    expect(s.itemAcc).toBe(0);
    expect(s.logLoss).toBeCloseTo(-Math.log(0.2), 12);
    expect(s.brier).toBeCloseTo(0.8 ** 2 * 2, 12);
  });

  it('uses 1 − |E[index] − answer| / 4 for score items', () => {
    const dist = { '0': 0, '1': 0, '2': 0.5, '3': 0.5, '4': 0 };
    const s = scorePrediction('score', dist, '4');
    expect(s.itemAcc).toBeCloseTo(1 - Math.abs(2.5 - 4) / 4, 12);
    expect(s.top1).toBe(0);
  });

  it('floors p(answer) at 1e-4 for log loss', () => {
    expect(scorePrediction('choice', { a: 1, b: 0 }, 'b').logLoss).toBeCloseTo(-Math.log(1e-4), 12);
  });

  it('measures repeat agreement', () => {
    expect(repeatAgreement('choice', 'a', 'a')).toBe(1);
    expect(repeatAgreement('noul', 'yes', 'no')).toBe(0);
    expect(repeatAgreement('score', '1', '3')).toBe(0.5);
  });

  it('computes ECE', () => {
    expect(
      expectedCalibrationError([
        { confidence: 0.95, correct: 1 },
        { confidence: 0.95, correct: 1 },
      ]),
    ).toBeCloseTo(0.05, 12);
    expect(expectedCalibrationError([])).toBe(0);
  });
});

describe('distributions', () => {
  it('normalizes, clips to [1e-4, 1] and renormalizes', () => {
    const d = normalizeDist({ a: 2, b: 0, c: 2, junk: 5 }, ['a', 'b', 'c']);
    expect(Object.keys(d)).toEqual(['a', 'b', 'c']);
    expect(d.b).toBeGreaterThan(0);
    expect(d.a! + d.b! + d.c!).toBeCloseTo(1, 12);
    expect(d.a).toBeCloseTo(d.c!, 12);
  });

  it('falls back to uniform on empty input', () => {
    expect(normalizeDist({}, ['x', 'y'])).toEqual({ x: 0.5, y: 0.5 });
  });

  it('computes entropy and argmax', () => {
    expect(entropy({ a: 0.5, b: 0.5 })).toBeCloseTo(Math.log(2), 12);
    expect(normalizedEntropy({ a: 0.5, b: 0.5 })).toBeCloseTo(1, 12);
    expect(argmax({ a: 0.1, b: 0.9 })).toBe('b');
  });
});

describe('Jev mapping (PLAN §5.1)', () => {
  const yn = [
    { key: 'yes', label: 'Yes' },
    { key: 'no', label: 'No' },
  ];
  it('maps noul p(yes) onto yes/no', () => {
    const d = answerToDistribution({ type: 'noul', options: yn }, { type: 'noul', p: 0.9 });
    expect(d.yes).toBeCloseTo(0.9, 6);
    expect(d.no).toBeCloseTo(0.1, 6);
  });

  it('maps score probabilities by level index onto our option keys', () => {
    const options = ['0', '1', '2', '3', '4'].map((key) => ({ key, label: `L${key}` }));
    const d = answerToDistribution(
      { type: 'score', options },
      { type: 'score', score: 3.9, probabilities: { '3': 0.1, '4': 0.9 } },
    );
    expect(d['4']).toBeCloseTo(0.9, 3);
    expect(d['0']).toBeGreaterThan(0);
  });

  it('rejects a mismatched answer type', () => {
    expect(() =>
      answerToDistribution({ type: 'noul', options: yn }, { type: 'choice', choice: 'a', probabilities: {} }),
    ).toThrow();
  });

  it('applies the tuned gate thresholds (ADR-0015)', () => {
    expect(gateFailures({ ambiguous: 0.9, sensitive: 0.1, leading: 0.6, quick: 0.5 })).toEqual([
      'ambiguous',
      'leading',
      'quick',
    ]);
    expect(gateFailures({ ambiguous: 0.8, sensitive: 0.45, leading: 0.5, quick: 0.7 })).toEqual([
      'sensitive',
    ]);
    expect(gateFailures({ ambiguous: 0.2, sensitive: 0.2, leading: 0.2, quick: 0.9 })).toEqual([]);
  });
});

describe('hashing and config (PLAN §7.1)', () => {
  it('implements SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('é'.repeat(100))).toHaveLength(64);
  });

  it('canonical JSON ignores key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('config hash is stable across key order and changes with any field', () => {
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    const shuffled = reverseKeys(DEFAULT_CONFIG) as PipelineConfig;
    expect(Object.keys(shuffled)[0]).toBe('embedding');
    expect(configHash(shuffled)).toBe(configHash(DEFAULT_CONFIG));
    const changed: PipelineConfig = { ...DEFAULT_CONFIG, reveal: 'never' };
    expect(configHash(changed)).not.toBe(configHash(DEFAULT_CONFIG));
  });

  it('pins the hash of cfg.default.v4 and its predecessors (configs are immutable: a change needs a new config)', () => {
    expect(configHash(DEFAULT_CONFIG)).toBe(
      '9783a40b1abf03d36281002a627336edfec98930f993cb62f542a206916460c3',
    );
    expect(configHash(DEFAULT_CONFIG)).toBe(sha256Hex(canonicalJson(DEFAULT_CONFIG)));
    expect(DEFAULT_CONFIG.selector.type).toBe('voi');
    expect(DEFAULT_CONFIG.generator.promptVersion).toBe('gen.v2');
    expect(DEFAULT_CONFIG.stateBuilder.latencyHints).toBe(true);
    // v3 (ADR-0025) must keep its hash even though the schema gained optional fields (ADR-0026).
    expect(configHash(DEFAULT_CONFIG_V3)).toBe(
      '076c57200e027d35b7a23582003c1161501b635469800fd1189c369d97160993',
    );
    // Older defaults differ from v3 only in their shadows, and mimics created under them still resolve to their rows.
    const withShadows = (shadows: string[]): PipelineConfig => ({
      ...DEFAULT_CONFIG_V3,
      predictor: { ...DEFAULT_CONFIG_V3.predictor, shadows },
    });
    const v1 = DEFAULT_CONFIG_V3.predictor.shadows.slice(0, 3);
    expect(configHash(withShadows(v1))).toBe(
      '913b29e8d48a8ba54702cb7878cc1e9079e379a0c784e5a213328a015b10843e',
    );
    // v2 (ADR-0024) added MiMo V2.6 Pro; v3 (ADR-0025) replaced it with MiMo V2.6 Flash and Qwen3.8 Flash.
    expect(configHash(withShadows([...v1, 'llm:xiaomi/mimo-v2.6-pro']))).toBe(
      'c597daa8c51b8105827893241dfcbf8396ca4dc4e0f3aa8d197447aca3f7d15c',
    );
  });

  it('unitHash is stable and in [0, 1)', () => {
    expect(unitHash('x')).toBe(unitHash('x'));
    expect(unitHash('x')).toBeGreaterThanOrEqual(0);
    expect(unitHash('x')).toBeLessThan(1);
  });

  it('ULIDs sort by time and round-trip their timestamp', () => {
    const a = ulid(1_790_000_000_000);
    const b = ulid(1_790_000_000_001);
    expect(a < b).toBe(true);
    expect(a).toHaveLength(26);
    expect(ulidTime(a)).toBe(1_790_000_000_000);
  });
});

describe('fidelity (PLAN §9.10)', () => {
  it('smooths self-consistency toward the 0.8 prior', () => {
    expect(selfConsistency([])).toBeCloseTo(0.8, 12);
    expect(selfConsistency([1, 1, 1, 1, 1])).toBeCloseTo((5 + 4) / 10, 12);
  });

  it('divides accuracy by self-consistency, capped at 1', () => {
    const scored = Array.from({ length: 20 }, (_, i) => ({ itemAcc: i % 2, baselineItemAcc: 0.25 }));
    const f = computeFidelity({ scored, repeatAgreements: [], seed: 's' });
    expect(f.acc).toBeCloseTo(0.5, 12);
    expect(f.accBaseline).toBeCloseTo(0.25, 12);
    expect(f.fidelity).toBeCloseTo(0.5 / 0.8, 12);
    expect(f.ciLow).toBeLessThan(f.fidelity);
    expect(f.ciHigh).toBeGreaterThan(f.fidelity);
    expect(f.state).toBe('learning');
    const perfect = computeFidelity({
      scored: scored.map(() => ({ itemAcc: 1, baselineItemAcc: null })),
      repeatAgreements: [],
      seed: 's',
    });
    expect(perfect.fidelity).toBe(1);
    expect(perfect.state).toBe('stable');
  });

  it('is calibrating below 12 scored items and reproducible for a seed', () => {
    const scored = Array.from({ length: 11 }, () => ({ itemAcc: 1, baselineItemAcc: 0 }));
    const a = computeFidelity({ scored, repeatAgreements: [1], seed: 'x' });
    expect(a.state).toBe('calibrating');
    expect(computeFidelity({ scored, repeatAgreements: [1], seed: 'x' })).toEqual(a);
  });

  it('uses only the most recent 30 scored predictions', () => {
    const scored = [
      ...Array.from({ length: 10 }, () => ({ itemAcc: 0, baselineItemAcc: 0 })),
      ...Array.from({ length: 30 }, () => ({ itemAcc: 1, baselineItemAcc: 0 })),
    ];
    const f = computeFidelity({ scored, repeatAgreements: [], seed: 's' });
    expect(f.nScored).toBe(30);
    expect(f.acc).toBe(1);
  });
});
