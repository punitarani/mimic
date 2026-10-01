import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalPredictorId,
  componentProblems,
  DEFAULT_CONFIG,
  type DecisionAnswer,
  type DecisionPredictor,
  type DecisionProvider,
  type DecisionRequest,
  Gateway,
  INCUMBENT_COMPONENTS,
  ulid,
  uncalibrate,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_REFLECTION_HINT, FakeLlm } from '../src/fakes';
import { type LocalEngine, openLocalEngine } from '../src/local';
import {
  againstPrimary,
  breakdown,
  calibrationFits,
  changedComponents,
  changedHarness,
  derivedCalibrations,
  evaluateCandidate,
  feedbackFor,
  jevRequests,
  Meter,
  MIN_INTERVAL_PEOPLE,
  type Pair,
  pairedByPerson,
  pairedComparisons,
  pairedDelta,
  personTemperature,
  predictorFor,
  prequentialTemperatures,
  probabilityAudit,
  RESIDUAL_MIN_OTHERS,
  residualReport,
  resolveCandidate,
  storedRecords,
  temperatureScale,
  toRecord,
} from '../src/optimize/evaluate';
import {
  judge,
  MIN_HOLDOUT,
  nextVersion,
  optimize,
  sampleParent,
  splitInstances,
  variantSnippet,
} from '../src/optimize/gepa';
import { type EvalInstance, loadInstances } from '../src/optimize/instances';
import {
  leakageProblems,
  leakCorpus,
  parseReflection,
  proposeComponent,
  targetWords,
} from '../src/optimize/reflect';
import { compactMetrics, METRICS_ROW_LIMIT, renderReport } from '../src/report';
import { runSession, SessionScript } from '../src/session';

let engine: LocalEngine;
let instances: EvalInstance[];
/** The production primary as stored (ADR-0054): configs spell it `jev:`, rows `decision:`. */
const PRIMARY = canonicalPredictorId(DEFAULT_CONFIG.predictor.primary);
const dirs: string[] = [];

/** Six scripted people who always pick the first option; the last one declined research use. */
beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'optimize-cohort' });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const script = SessionScript.parse({
      intake: { name: `Person ${i}`, location: 'Porto, PT', occupation: 'Teacher', employer: 'Escola Norte' },
      consentResearch: i < 5,
      policy: 'first',
      seed: `p${i}`,
      whys: { 'anchors.v1/risk_gamble': 'Certainty matters more to me than upside.' },
    });
    ids.push((await runSession(engine, script, { turns: 22 })).mimicId);
  }
  // The split is hash(mimicId), and IDs shift whenever a session makes another call; pin one consented person to test
  // so the holdout always has someone on it.
  await engine.client.execute({ sql: "UPDATE mimics SET split = 'test' WHERE id = ?", args: [ids[4]!] });
  instances = await loadInstances(engine.deps, { k: 30, split: 'all', seed: 's' });
}, 120_000);

afterAll(() => {
  engine.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A stand-in decision model whose predictions get sharper toward the first option (what every scripted person picks)
 * when the instructions carry the fake reflection's hint, so a reflected child measurably beats its parent.
 */
class HintDecisions implements DecisionProvider {
  readonly provider = 'hint-decisions';
  calls = 0;
  async decide(req: DecisionRequest) {
    this.calls++;
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      const sharp = q.instructions.includes(FAKE_REFLECTION_HINT);
      const first = sharp ? 0.8 : 0.4;
      if (q.type === 'noul') answers[key] = { type: 'noul', p: first };
      else {
        const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
        const rest = (1 - first) / (keys.length - 1);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? first : rest]));
        answers[key] =
          q.type === 'choice'
            ? { type: 'choice', choice: keys[0]!, probabilities }
            : { type: 'score', score: 1, probabilities };
      }
    }
    return {
      modelSnapshot: 'typesafe/jev-1.13-hint',
      answers,
      usage: { inputTokens: 100, outputTokens: 0, costUsd: 0.0001 },
      latencyMs: 1,
      raw: {},
    };
  }
}

function gateway(decisions: DecisionProvider = new HintDecisions()) {
  return new Gateway({
    decisions,
    llm: new FakeLlm(),
    log: { write: async () => {} },
    clock: () => Date.now(),
    newId: ulid,
  });
}

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mimic-opt-'));
  dirs.push(d);
  return d;
}

describe('evaluation instances', () => {
  it('rebuilds a sealed state per served question, for consented people only', () => {
    expect(new Set(instances.map((i) => i.mimicId)).size).toBe(5);
    expect(instances.length).toBeGreaterThan(80);
    for (const i of instances) {
      expect(i.mode).toBe('online');
      expect(i.state.meta.evidenceSeqMax).toBeLessThan(i.seq);
      expect(i.state.evidence.every((e) => e.seq < i.seq)).toBe(true);
      expect(['anchor', 'adaptive']).toContain(i.question.kind);
    }
    // The stored online predictions come along: 1 primary, 1 baseline and the shadows per question.
    const one = instances.find((i) => i.stored.length)!;
    expect(one.stored.filter((p) => p.role === 'primary')).toHaveLength(1);
    expect(one.baseline).not.toBeNull();
    expect(instances.some((i) => i.why)).toBe(true);
    expect(instances.some((i) => i.repeatAgreement !== null)).toBe(true);
    // Name, location parts and employer feed the leakage lint.
    expect(instances.every((i) => i.identityTerms.includes('Escola Norte'))).toBe(true);
    expect(instances.every((i) => i.identityTerms.some((t) => t.startsWith('Person ')))).toBe(true);
  });

  it('keeps test people out of training and validation', () => {
    const s = splitInstances(instances, { valSize: 1000, holdoutSize: 1000, rngSeed: 's' });
    expect([...s.train, ...s.val].every((i) => i.split === 'dev')).toBe(true);
    expect(s.holdout.every((i) => i.split === 'test')).toBe(true);
    expect(s.train.length + s.val.length).toBe(instances.filter((i) => i.split === 'dev').length);
  });
});

describe('evaluate', () => {
  it('scores stored predictions and fits calibration without model calls', () => {
    const recs = storedRecords(instances);
    const primary = recs.filter((r) => r.candidate === `${PRIMARY}|primary`);
    expect(primary.length).toBe(instances.length);
    const b = breakdown(primary);
    expect(b.all.n).toBe(instances.length);
    expect(b.all.lift).not.toBeNull();
    expect(Object.keys(b.byType).length).toBeGreaterThan(1);
    const fits = calibrationFits(instances);
    expect(fits.some((f) => f.method === 'temperature')).toBe(true);
    // The primary also gets a temperature per band of answers in the state.
    expect(
      fits.some((f) => f.predictor.endsWith('(primary)') && f.method.includes('answers in the state')),
    ).toBe(true);
    for (const f of fits) expect(f.fitAfter).toBeLessThanOrEqual(f.fitBefore + 1e-9);
    const t = temperatureScale({ a: 0.9, b: 0.1 }, 2);
    expect(t.a).toBeLessThan(0.9);
    expect(t.a! + t.b!).toBeCloseTo(1);
  });

  it('compares every shadow with the primary over people, and gives view shadows ADR-0065 verdicts', () => {
    const recs = storedRecords(instances);
    const rows = againstPrimary(recs);
    const derived = rows.find((r) => r.predictor === 'decision:typesafe/jev-1.13@jev-derived.v1')!;
    expect(derived.primary).toBe(PRIMARY);
    expect(derived.view).toBe('derived');
    // Five scripted people are far from the 25 the rule needs.
    expect(derived.logLoss.people).toBe(5);
    expect(derived.verdict).toBe('insufficient');
    expect(rows.find((r) => r.predictor.endsWith('@predict.v2-context'))!.view).toBe('context');
    // An LLM shadow is compared across models but reads the whole state, so it gets no verdict.
    const luna = rows.find((r) => r.predictor === 'llm:openai/gpt-6-luna@predict.v2')!;
    expect(luna.view).toBeNull();
    expect(luna.verdict).toBeNull();
    // A person-level interval is no narrower than a question-level one on the same pairs.
    const p = recs.filter((r) => r.candidate === `${PRIMARY}|primary`);
    const x = recs.filter((r) => r.candidate === 'llm:openai/gpt-6-luna@predict.v2|shadow');
    const q = pairedDelta(p, x, 'logLoss', 'q', 2000);
    const byP = pairedByPerson(p, x, 'logLoss', 'q', 2000);
    expect(byP.mean).toBeCloseTo(q.mean, 9);
    expect(byP.better + byP.worse).toBeLessThanOrEqual(byP.people);
    expect(byP.ciHigh - byP.ciLow).toBeGreaterThan((q.ciHigh - q.ciLow) * 0.5);
  });

  it('shows an interval over people only from five people, and says what hypothesis rows are', () => {
    const recs = storedRecords(instances);
    const twoPeople = new Set([...new Set(instances.map((i) => i.mimicId))].slice(0, 2));
    const render = (rows: ReturnType<typeof againstPrimary>) =>
      renderReport({
        id: 'R',
        name: 'stored',
        spec: { kind: 'evaluate', mode: 'stored' },
        datasetHash: 'h',
        status: 'done',
        metrics: {
          people: rows[0]!.logLoss.people,
          instances: rows[0]!.logLoss.n,
          predictors: [{ predictor: PRIMARY, role: 'hypothesis', all: breakdown(recs.slice(0, 3)).all }],
          againstPrimary: rows,
        },
        r2ReportKey: null,
        createdAt: 0,
      });
    const derivedRow = (md: string) => md.split('\n').find((l) => l.includes('jev-derived.v1` (shadow)'))!;
    expect(MIN_INTERVAL_PEOPLE).toBe(5);
    const five = render(againstPrimary(recs));
    expect(derivedRow(five)).toMatch(/\[[-+]\d/);
    expect(five).toContain('`hypothesis` rows are');
    const two = render(againstPrimary(recs.filter((r) => twoPeople.has(r.mimicId))));
    expect(derivedRow(two)).toContain('[—]');
    expect(derivedRow(two)).not.toMatch(/\[[-+]\d/);
  });

  it('scores residual skill against a leave-one-out item mean on shared items only (RESEARCH §1.2)', () => {
    const recs = storedRecords(instances);
    // Five people share the anchors: each has four others, under the default minimum.
    expect(RESIDUAL_MIN_OTHERS).toBe(5);
    expect(residualReport(instances, recs).instances).toBe(0);
    const r = residualReport(instances, recs, 4);
    expect(r.people).toBe(5);
    expect(r.items).toBeGreaterThan(3);
    // Every scripted person picks the first option, so the population predicts them well: the item mean is the
    // first option at (4 + 0.5) / (4 + 0.5·options).
    expect(r.itemMean.itemAcc).toBeGreaterThan(0.6);
    const primary = r.rows.find((x) => x.role === 'primary')!;
    expect(primary.logLoss.n).toBe(r.instances);
    expect(r.rows.some((x) => x.role === 'baseline')).toBe(true);
    expect(r.rows.some((x) => x.predictor === 'item-mean')).toBe(false);
    // Pooling with the item mean is fitted on dev people and scored on test people, when there are both.
    const people = new Set(instances.map((i) => `${i.mimicId}:${i.split}`));
    const splits = new Set([...people].map((p) => p.split(':')[1]));
    if (splits.size === 2) {
      expect(primary.pooled!.w).toBeGreaterThanOrEqual(0);
      expect(primary.pooled!.w).toBeLessThanOrEqual(1);
      expect(primary.pooled!.logLoss.n).toBeGreaterThan(0);
    } else expect(primary.pooled).toBeNull();
  });

  it("fits a person's temperature only from their earlier questions, shrunk toward the global one (RESEARCH §2.4)", () => {
    const temps = [0.5, 1, 2, 4, 8];
    const pairs: Pair[] = instances
      .filter((i) => i.stored.some((p) => p.role === 'primary' && p.ok))
      .map((inst) => ({ inst, dist: inst.stored.find((p) => p.role === 'primary' && p.ok)!.dist }));
    const one = pairs.filter((p) => p.inst.mimicId === pairs[0]!.inst.mimicId);
    expect(personTemperature([], 2, 0, temps)).toBe(2);
    expect(personTemperature(one, 2, Number.POSITIVE_INFINITY, temps)).toBe(2);
    // No shrinkage: the person's own best temperature on the grid.
    expect(temps).toContain(personTemperature(one, 2, 0, temps));
    const t = prequentialTemperatures(pairs, 2, 10, temps);
    const first = new Map<string, Pair>();
    for (const p of [...pairs].sort((a, b) => a.inst.seq - b.inst.seq))
      if (!first.has(p.inst.mimicId)) first.set(p.inst.mimicId, p);
    for (const p of first.values()) expect(t.get(p)).toBe(2);
    // Changing a person's last answer leaves every earlier temperature where it was.
    const last = [...one].sort((a, b) => b.inst.seq - a.inst.seq)[0]!;
    const changed = pairs.map((p) =>
      p === last ? { ...p, inst: { ...p.inst, answer: p.inst.question.options.at(-1)!.key } } : p,
    );
    const t2 = prequentialTemperatures(changed, 2, 10, temps);
    for (const [i, p] of pairs.entries()) if (p !== last) expect(t2.get(changed[i]!)).toBe(t.get(p));
  });

  it('counts the distinct top probabilities each predictor says (RESEARCH §2.5)', () => {
    const recs = storedRecords(instances);
    const audit = probabilityAudit(recs);
    const primary = audit.find((a) => a.candidate === `${PRIMARY}|primary`)!;
    expect(primary.n).toBe(recs.filter((r) => r.candidate === `${PRIMARY}|primary` && r.ok).length);
    expect(primary.distinct).toBeGreaterThan(0);
    expect(primary.modeShare).toBeGreaterThan(0);
    expect(primary.modeShare).toBeLessThanOrEqual(1);
    const fake = recs
      .slice(0, 4)
      .map((r, i) => ({ ...r, candidate: 'x|shadow', confidence: i < 3 ? 0.95 : 0.6 }));
    expect(probabilityAudit(fake)).toEqual([
      { candidate: 'x|shadow', n: 4, distinct: 2, mode: 0.95, modeShare: 0.75 },
    ]);
  });

  it('derives calibrated Jev from the stored primary for free, and reports what calibration does to accuracy', () => {
    // Mimics made before cfg.default.v7 store an uncalibrated primary: this cohort's v7 rows on Jev's raw scale.
    const raw = (p: EvalInstance['stored'][number]) =>
      p.role === 'baseline' || p.role === 'primary'
        ? { ...p, predictorId: 'jev:typesafe/jev-1.13', dist: p.ok ? uncalibrate(p.dist, 4) : p.dist }
        : p;
    const legacy = instances.map((i) => ({ ...i, stored: i.stored.map(raw) }));
    const recs = storedRecords(legacy);
    // Stored as `jev:` (before ADR-0054), reported under the canonical spelling.
    const primary = recs.filter((r) => r.candidate === 'decision:typesafe/jev-1.13|primary');
    const derived = recs.filter((r) => r.candidate === 'decision:typesafe/jev-1.13@jev-predict.v2|derived');
    expect(derived).toHaveLength(primary.length);
    const v7 = new Map(
      storedRecords(instances)
        .filter((r) => r.candidate === `${PRIMARY}|primary`)
        .map((r) => [r.instanceId, r]),
    );
    for (const d of derived) {
      const p = primary.find((x) => x.instanceId === d.instanceId)!;
      expect(d.costUsd).toBe(0);
      if (!p.ok) continue;
      expect(d.dist).toEqual(temperatureScale(p.dist, 4));
      // Deriving from the raw primary gives back what a v7 primary stores (to the P_FLOOR clip).
      expect(Math.abs(d.logLoss - v7.get(d.instanceId)!.logLoss)).toBeLessThan(1e-3);
    }
    // Only calibration-only variants of the primary's own templates are derived; LLM primaries have none.
    expect(derivedCalibrations('jev:typesafe/jev-1.13')).toEqual([
      { predictorId: 'decision:typesafe/jev-1.13@jev-predict.v2', t: 4 },
    ]);
    expect(derivedCalibrations('decision:typesafe/jev-1.13')).toEqual(
      derivedCalibrations('jev:typesafe/jev-1.13'),
    );
    expect(derivedCalibrations('llm:deepseek/deepseek-v4.1-flash')).toEqual([]);
    // A primary that is already calibrated (cfg.default.v7) has nothing to derive.
    expect(derivedCalibrations(DEFAULT_CONFIG.predictor.primary)).toEqual([]);
    // Paired comparisons put the two on the same questions (ADR-0048).
    const pair = pairedComparisons(recs).find(
      (x) => x.from === 'decision:typesafe/jev-1.13' && x.to === 'decision:typesafe/jev-1.13@jev-predict.v2',
    )!;
    expect(pair.n).toBe(primary.length);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(pair.logLoss.mean).toBeCloseTo(
      mean(derived.map((r) => r.logLoss)) - mean(primary.map((r) => r.logLoss)),
      9,
    );
    expect(pair.logLoss.ciLow).toBeLessThanOrEqual(pair.logLoss.mean);
    expect(pair.logLoss.ciHigh).toBeGreaterThanOrEqual(pair.logLoss.mean);
    // Baselines see another state, so they are never paired, though they carry the primary's predictor ID.
    const baselines = recs.filter((r) => r.candidate.endsWith('|baseline'));
    expect(baselines.length).toBeGreaterThan(0);
    expect(baselines.every((r) => r.predictorId === 'decision:typesafe/jev-1.13')).toBe(true);
    expect(pairedComparisons(recs.filter((r) => !baselines.includes(r)))).toEqual(pairedComparisons(recs));
    // Fits report test accuracy before and after, and pool with the primary only predictors that see something else:
    // LLM shadows and view shadows (ADR-0065).
    const fits = calibrationFits(instances);
    for (const f of fits.filter((x) => x.nTest > 0)) {
      expect(f.testAccBefore).toBeTypeOf('number');
      expect(f.testAccAfter).toBeTypeOf('number');
    }
    const pools = fits.filter((x) => x.method.startsWith('log-linear pool'));
    for (const f of pools)
      expect(
        f.predictor.startsWith('llm:') || f.predictor.startsWith('decision:typesafe/jev-1.13@jev-derived.v1'),
      ).toBe(true);
    expect(pools.some((f) => f.predictor.startsWith('decision:typesafe/jev-1.13@jev-derived.v1 ×'))).toBe(
      true,
    );
  });

  it('pairs versions of one model in numeric order, one row per question (ADR-0048)', () => {
    const primary = storedRecords(instances).filter((r) => r.candidate === `${PRIMARY}|primary`);
    const as = (id: string, role = 'shadow') =>
      primary.map((r) => ({ ...r, candidate: `${id}|${role}`, predictorId: id }));
    const recs = ['llm:x/y@predict.v10', 'llm:x/y', 'llm:x/y@predict.v2', 'llm:z/w@predict.v2'].flatMap(
      (id) => as(id),
    );
    const pairs = pairedComparisons(recs);
    expect(pairs.map((p) => `${p.from} > ${p.to}`)).toEqual([
      'llm:x/y > llm:x/y@predict.v2',
      'llm:x/y > llm:x/y@predict.v10',
      'llm:x/y@predict.v2 > llm:x/y@predict.v10',
    ]);
    // A predictor that appears twice for a question (a shadow and a derived row, say) counts once.
    expect(pairedComparisons([...recs, ...as('llm:x/y', 'derived')]).map((p) => p.n)).toEqual(
      pairs.map(() => primary.length),
    );
  });

  it('keeps a primary the LLM fallback served out of the primary, its derived rows, pairs and fits', () => {
    // Every question here fell over to the LLM: nothing in it is the configured primary's prediction.
    const fallback = 'llm:deepseek/deepseek-v4.1-flash';
    const failedOver = instances.map((i) => ({
      ...i,
      stored: i.stored.map((p) =>
        p.role === 'primary' ? { ...p, predictorId: fallback, fallback: true } : p,
      ),
    }));
    const recs = storedRecords(failedOver);
    expect(recs.filter((r) => r.candidate === `${fallback}|fallback`)).toHaveLength(instances.length);
    expect(recs.some((r) => r.candidate.endsWith('|primary') || r.candidate.endsWith('|derived'))).toBe(
      false,
    );
    expect(pairedComparisons(recs).some((p) => p.from === fallback || p.to === fallback)).toBe(false);
    expect(calibrationFits(failedOver).some((f) => f.predictor.includes('(primary)'))).toBe(false);
  });

  it('a candidate that only changes the view is a change: its predictor reads that view (ADR-0065)', () => {
    const c = resolveCandidate({
      predictor: 'decision:typesafe/jev-1.13@jev-predict.v2',
      harness: { stateView: 'context' },
    });
    expect(changedHarness(c)).toEqual({ stateView: 'context' });
    const p = predictorFor(gateway(), c, 't') as DecisionPredictor;
    expect(p.prompt.harness.stateView).toBe('context');
    expect(p.prompt.version.startsWith('cand-')).toBe(true);
  });

  it('refuses a candidate whose reasoning budget leaves no room for the answer, or a model a variant does not list', () => {
    expect(() =>
      resolveCandidate({
        predictor: 'llm:qwen/qwen3.8-flash@predict.v2',
        harness: { reasoningMaxTokens: 4096 },
      }),
    ).toThrow(/leaves under 256 tokens/);
    expect(() => resolveCandidate({ predictor: 'llm:acme/other@predict.v2' })).toThrow(
      /no measured reasoning/,
    );
    expect(resolveCandidate({ predictor: 'llm:acme/other' }).prompt.harness.maxTokens).toBe(3000);
  });

  it('writes feedback from the answer, the reason, the baseline and repeat agreement', () => {
    const inst = instances.find((i) => i.why && i.baseline)!;
    const rec = toRecord(inst, 'c', 'p', {
      dist: Object.fromEntries(
        inst.question.options.map((o, j) => [
          o.key,
          j === 0 ? 0.1 : 0.9 / (inst.question.options.length - 1),
        ]),
      ),
      ok: true,
      costUsd: 0,
      latencyMs: 1,
      modelSnapshot: 'm',
    });
    expect(rec.feedback).toContain("The person's own reason");
    expect(rec.feedback).toContain('profile-only guess');
    const failed = toRecord(inst, 'c', 'p', {
      dist: {},
      ok: false,
      error: 'boom',
      costUsd: 0,
      latencyMs: 0,
      modelSnapshot: 'm',
    });
    expect(failed.value).toBeLessThan(-Math.log(inst.question.options.length));
    expect(feedbackFor(inst, failed)).toContain('failed (boom)');
  });

  it('candidate hashes are pinned (ADR-0054 kept them through the rename)', () => {
    expect(resolveCandidate({ predictor: 'jev:typesafe/jev-1.13' }).hash).toBe(
      'typesafe/jev-1.13:00e3cc2e765d2f3a',
    );
    expect(resolveCandidate({ predictor: 'jev:typesafe/jev-1.13@jev-predict.v2' }).hash).toBe(
      'typesafe/jev-1.13:abc36f61fbb37cab',
    );
    const edited = { 'jev.choice': 'They would pick: {label}' };
    expect(resolveCandidate({ predictor: 'jev:typesafe/jev-1.13', components: edited }).hash).toBe(
      'typesafe/jev-1.13:3537092ff2e42000',
    );
  });

  it('runs a candidate through the gateway, caching by candidate and instance', async () => {
    const decisions = new HintDecisions();
    const gw = gateway(decisions);
    const c = resolveCandidate({ predictor: 'jev:typesafe/jev-1.13' });
    expect(predictorFor(gw, c, 'x').id).toBe('decision:typesafe/jev-1.13');
    const cache = new Map();
    const meter = new Meter();
    const xs = instances.slice(0, 12);
    const a = await evaluateCandidate(c, xs, { gateway: gw, meter, cache });
    expect(meter.predictions).toBe(12);
    const b = await evaluateCandidate(c, xs, { gateway: gw, meter, cache });
    expect(meter.predictions).toBe(12);
    expect(b).toEqual(a);
    const hinted = resolveCandidate({
      predictor: 'jev:typesafe/jev-1.13',
      components: {
        'jev.instructions': `${INCUMBENT_COMPONENTS['jev.instructions']} ${FAKE_REFLECTION_HINT}`,
      },
    });
    expect(Object.keys(changedComponents(hinted))).toEqual(['jev.instructions']);
    expect(predictorFor(gw, hinted, 'x').id).toMatch(/^decision:typesafe\/jev-1\.13@cand-/);
    const h = await evaluateCandidate(hinted, xs, { gateway: gw, meter, cache });
    expect(pairedDelta(a, h).mean).toBeGreaterThan(0);
    await expect(
      evaluateCandidate(c, instances.slice(12, 20), { gateway: gw, meter: new Meter(0), cache }),
    ).rejects.toThrow(/spend cap/);
  });
});

describe('outages, batching and splits', () => {
  class DownDecisions implements DecisionProvider {
    readonly provider = 'down';
    calls = 0;
    async decide(): Promise<never> {
      this.calls++;
      throw new Error('503 upstream unavailable');
    }
  }

  it('marks transport failures transient, retries them once, and never caches them', async () => {
    const down = new DownDecisions();
    const cache = new Map();
    const c = resolveCandidate({ predictor: 'jev:typesafe/jev-1.13' });
    const xs = instances.slice(0, 4);
    const recs = await evaluateCandidate(c, xs, { gateway: gateway(down), meter: new Meter(), cache });
    expect(recs.every((r) => r.transient && !r.ok)).toBe(true);
    expect(cache.size).toBe(0);
    // One request per state, plus one retry of the failed questions.
    expect(down.calls).toBe(2 * new Set(xs.map((i) => i.state.meta.stateHash)).size);
  });

  it('stops an optimize run on an outage instead of scoring it', async () => {
    await expect(
      optimize(
        { gateway: gateway(new DownDecisions()), runDir: tmp(), log: () => {} },
        {
          name: 'x',
          seed: { predictor: 'jev:typesafe/jev-1.13' },
          components: ['jev.instructions'],
          reflectionModel: 'r',
          maxMetricCalls: 400,
          maxUsd: 5,
          minibatch: 4,
          valSize: 10,
          holdoutSize: 10,
          maxIterations: 2,
          noise: false,
          concurrency: 2,
          rngSeed: 'o',
        },
        instances,
      ),
    ).rejects.toThrow(/provider outage/);
  });

  it('batches every Jev question that shares a state into one request, within the context budget', () => {
    const c = resolveCandidate({ predictor: 'jev:typesafe/jev-1.13' });
    const one = instances[0]!;
    const same = Array.from({ length: 60 }, (_, n) => ({ ...one, id: `${one.id}#${n}` }));
    expect(jevRequests(c, same)).toHaveLength(1);
    const big = same.map((i) => ({ ...i, question: { ...i.question, prompt: 'x '.repeat(4000) } }));
    expect(jevRequests(c, big).length).toBeGreaterThan(1);
    expect(jevRequests(c, big).flat()).toHaveLength(60);
    // E6 asks one question per request, so no arm differs by what else was in its batch.
    expect(jevRequests(c, same, 1)).toHaveLength(60);
    expect(jevRequests(c, same, 25).map((g) => g.length)).toEqual([25, 25, 10]);
  });

  it('splits six or more dev people into balanced train and val halves', () => {
    const fake = Array.from({ length: 7 }, (_, p) =>
      Array.from({ length: 3 }, (_, q) => ({
        ...instances[0]!,
        id: `m${p}:${q}`,
        mimicId: `m${p}`,
        split: 'dev' as const,
      })),
    ).flat();
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const s = splitInstances(fake, { valSize: 100, holdoutSize: 10, rngSeed: seed });
      expect(s.by).toBe('person');
      expect(new Set(s.val.map((i) => i.mimicId)).size).toBe(4);
      expect(new Set(s.train.map((i) => i.mimicId)).size).toBe(3);
    }
  });

  it('refuses to resume a run directory against different data', async () => {
    const runDir = tmp();
    const spec = {
      name: 'x',
      seed: { predictor: 'jev:typesafe/jev-1.13' },
      components: ['jev.instructions' as const],
      reflectionModel: 'r',
      maxMetricCalls: 400,
      maxUsd: 5,
      minibatch: 4,
      valSize: 10,
      holdoutSize: 10,
      maxIterations: 1,
      noise: false,
      concurrency: 2,
      rngSeed: 'o',
    };
    await optimize({ gateway: gateway(), runDir, log: () => {} }, spec, instances);
    const renamed = instances.map((i) => ({ ...i, id: `x${i.id}` }));
    await expect(optimize({ gateway: gateway(), runDir, log: () => {} }, spec, renamed)).rejects.toThrow(
      /not in this data/,
    );
  }, 60_000);

  it('compacts published metrics that would overflow a D1 statement', () => {
    const small = { a: 1 };
    expect(compactMetrics(small)).toBe(small);
    const big = { people: 50, rows: [{ byPerson: { p: 'x'.repeat(70_000) }, all: { n: 1 } }] };
    const c = compactMetrics(big) as Record<string, unknown>;
    expect(JSON.stringify(c).length).toBeLessThan(METRICS_ROW_LIMIT);
    expect(c.compacted).toBeDefined();
    expect((c.rows as Array<Record<string, unknown>>)[0]!.all).toEqual({ n: 1 });
  });
});

describe('verdict (ADR-0048)', () => {
  const ci = (mean: number, ciLow: number, ciHigh: number, n = 80) => ({ n, mean, ciLow, ciHigh });
  const metrics = { n: 80 } as never;
  const base = { sameAsSeed: false, holdoutError: null, margin: 0.0047 };

  it('calls the first prod run unconfirmed: its validation gain did not replicate on the holdout', () => {
    // Run 01M3SV0K3TK4NVMQ1BPGN9VRZN: validation +0.0523 (0.0091 to 0.1021), holdout +0.0056 (−0.0117 to 0.0234),
    // holdout item accuracy −3.8 points.
    const r = judge({
      ...base,
      val: ci(0.0523, 0.0091, 0.1021, 55),
      holdout: {
        seed: metrics,
        best: metrics,
        delta: ci(0.0056, -0.0117, 0.0234),
        accuracyDelta: ci(-0.038, -0.079, 0.001),
      },
    });
    expect(r.improved).toBe(false);
    expect(r.verdict).toMatch(/^Unconfirmed: .*did not replicate on the holdout.*item accuracy -3\.8 points/);
  });

  it('calls a replicated gain improved, and refuses one that costs accuracy or has no holdout', () => {
    const val = ci(0.05, 0.01, 0.1, 55);
    const holdout = { seed: metrics, best: metrics, delta: ci(0.03, 0.005, 0.06) };
    expect(judge({ ...base, val, holdout }).improved).toBe(true);
    expect(
      judge({ ...base, val, holdout: { ...holdout, accuracyDelta: ci(0.01, -0.02, 0.04) } }).improved,
    ).toBe(true);
    const worse = judge({ ...base, val, holdout: { ...holdout, accuracyDelta: ci(-0.06, -0.1, -0.02) } });
    expect(worse).toMatchObject({
      improved: false,
      verdict: expect.stringMatching(
        /^Unconfirmed: .*the holdout gain replicated.*but holdout item accuracy fell/,
      ),
    });
    expect(judge({ ...base, val, holdout: null }).verdict).toMatch(/no test-split people to confirm/);
    expect(judge({ ...base, val, holdout: { ...holdout, delta: ci(-0.02, -0.05, 0.01) } }).verdict).toMatch(
      /^Not shipped: it lost on the holdout/,
    );
    expect(judge({ ...base, val: ci(0.003, -0.01, 0.02, 55), holdout }).verdict).toMatch(/within noise/);
  });

  it(`needs at least ${MIN_HOLDOUT} holdout questions to confirm a gain`, () => {
    const val = ci(0.05, 0.01, 0.1, 55);
    const holdout = (n: number) => ({ seed: metrics, best: metrics, delta: ci(0.03, 0.005, 0.06, n) });
    expect(judge({ ...base, val, holdout: holdout(MIN_HOLDOUT - 1) })).toMatchObject({
      improved: false,
      verdict: expect.stringMatching(
        new RegExp(`^Unconfirmed: .*the holdout has only ${MIN_HOLDOUT - 1} questions`),
      ),
    });
    expect(judge({ ...base, val, holdout: holdout(MIN_HOLDOUT) }).improved).toBe(true);
  });
});

describe('leakage lint', () => {
  const corpus = () => leakCorpus(instances);
  it('rejects copied question text and identity details, allows general strategy', () => {
    const q = instances.find((i) => i.question.prompt.split(' ').length >= 8)!.question.prompt;
    expect(leakageProblems(`Consider: ${q}`, 'Base text.', corpus())[0]).toMatch(
      /copies person-authored text/,
    );
    expect(leakageProblems('People at Escola Norte tend to agree.', 'Base text.', corpus())).toContain(
      'names an identity detail of a person in the data',
    );
    expect(
      leakageProblems('Weigh recent answers more when they conflict with the profile.', 'Base.', corpus()),
    ).toEqual([]);
    // Text already in the parent is not new leakage.
    expect(leakageProblems(`Keep ${q}`, `Keep ${q}`, corpus())).toEqual([]);
  });

  it('gives an invalid reflection one repair turn naming its problems', async () => {
    const replies = ['<component>Too long {prompt}</component>', '<component>Short {prompt}</component>'];
    const seen: string[] = [];
    const gw = new Gateway({
      decisions: new HintDecisions(),
      llm: {
        provider: 'x',
        chat: async (req) => {
          seen.push(req.messages.at(-1)!.content);
          return {
            content: replies.shift()!,
            modelSnapshot: 'r',
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
            latencyMs: 1,
            raw: {},
          };
        },
      },
      log: { write: async () => {} },
      clock: () => 0,
      newId: ulid,
    });
    const c = resolveCandidate({ predictor: 'jev:typesafe/jev-1.13' });
    const r = await proposeComponent(gw, 'm', c, 'jev.instructions', 'cases', (t) =>
      t.startsWith('Too') ? ['too long'] : [],
    );
    expect(r).toMatchObject({ text: 'Short {prompt}', problems: [], calls: 2 });
    expect(r.costUsd).toBeCloseTo(0.02);
    expect(seen[1]).toContain("That text can't be used: too long");
  });

  it('aims below the word limit and names the cut when a reply runs over (optimize.reflect.v2)', async () => {
    const long = `<component>{prompt} ${'word '.repeat(130).trim()}</component>`;
    const replies = [long, '<component>Short {prompt}</component>'];
    const seen: string[] = [];
    const gw = new Gateway({
      decisions: new HintDecisions(),
      llm: {
        provider: 'x',
        chat: async (req) => {
          seen.push(req.messages.at(-1)!.content);
          return {
            content: replies.shift()!,
            modelSnapshot: 'r',
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
            latencyMs: 1,
            raw: {},
          };
        },
      },
      log: { write: async () => {} },
      clock: () => 0,
      newId: ulid,
    });
    const c = resolveCandidate({ predictor: 'jev:typesafe/jev-1.13' });
    const r = await proposeComponent(gw, 'm', c, 'jev.instructions', 'cases', (t) =>
      componentProblems('jev.instructions', t),
    );
    expect(r.problems).toEqual([]);
    expect(targetWords('jev.instructions')).toBe(102);
    expect(seen[0]).toContain('WORD LIMIT: 120, hard. Aim for 102 or fewer');
    // 131 words: cut at least 29 to reach the target, not just the 11 over the limit.
    expect(seen[1]).toContain('It has 131 words: cut at least 29 (to about 102)');
  });

  it('parses the reflection reply', () => {
    expect(parseReflection('Sure.\n<component>\nNew {prompt}\n</component>')).toBe('New {prompt}');
    expect(parseReflection('no tags')).toBeNull();
  });
});

describe('optimize (GEPA loop, offline)', () => {
  const spec = {
    name: 'test run',
    seed: { predictor: 'jev:typesafe/jev-1.13' },
    components: ['jev.instructions' as const],
    reflectionModel: 'fake/reflector',
    maxMetricCalls: 400,
    maxUsd: 5,
    minibatch: 6,
    valSize: 30,
    holdoutSize: 30,
    maxIterations: 3,
    noise: true,
    concurrency: 4,
    rngSeed: 't',
  };

  it('accepts a reflected child that beats the seed, checks it on the holdout, and resumes', async () => {
    const runDir = tmp();
    const log: string[] = [];
    const r = await optimize({ gateway: gateway(), runDir, log: (l) => log.push(l) }, spec, instances);
    expect(r.state.pool.length).toBeGreaterThan(1);
    expect(r.state.history.some((h) => h.outcome === 'accepted')).toBe(true);
    expect(r.best.candidate.prompt.components['jev.instructions']).toContain(FAKE_REFLECTION_HINT);
    expect(r.improved).toBe(true);
    expect(r.suggestedVersion).toBe(nextVersion('decision'));
    expect(r.bestInput.components?.['jev.instructions']).toContain('{prompt}');
    expect(variantSnippet(r, 'RUN')).toContain(`'${nextVersion('decision')}': {`);
    // Deterministic fake: the noise floor is zero.
    expect(r.state.noise?.sd).toBe(0);
    const holdoutPeople = new Set(r.state.split.holdout.map((id) => id.split(':')[0]));
    const trainPeople = new Set([...r.state.split.train, ...r.state.split.val].map((id) => id.split(':')[0]));
    for (const p of holdoutPeople) expect(trainPeople.has(p)).toBe(false);

    expect(r.bestInput.predictor).toBe('decision:typesafe/jev-1.13');

    // A run directory from before ADR-0054 names the decision kind `jev`; it resumes as the same run.
    const statePath = join(runDir, 'state.json');
    const saved = readFileSync(statePath, 'utf8');
    expect(saved).toContain('"kind": "decision"');
    writeFileSync(statePath, saved.replaceAll('"kind": "decision"', '"kind": "jev"'));

    // Resume with a higher iteration limit: the pool and history carry over.
    const before = r.state.iteration;
    const r2 = await optimize(
      { gateway: gateway(), runDir, log: (l) => log.push(l) },
      { ...spec, maxIterations: before + 1 },
      instances,
    );
    expect(r2.state.iteration).toBe(before + 1);
    expect(r2.state.pool.length).toBeGreaterThanOrEqual(r.state.pool.length);
    expect(
      r2.state.pool.every((e) => e.candidate.kind === 'decision' && e.candidate.prompt.kind === 'decision'),
    ).toBe(true);
    expect(r2.state.pool[0]!.candidate.hash).toBe(r.state.pool[0]!.candidate.hash);
    expect(log.some((l) => l.startsWith('resuming'))).toBe(true);
    expect(readFileSync(join(runDir, 'cache.jsonl'), 'utf8').split('\n').length).toBeGreaterThan(30);
  }, 60_000);

  it('stops at the metric-call budget before starting an iteration it could not validate', async () => {
    const r = await optimize(
      { gateway: gateway(), runDir: tmp(), log: () => {} },
      { ...spec, maxMetricCalls: 70 },
      instances,
    );
    expect(r.state.stopReason).toMatch(/metric-call budget/);
    expect(r.state.meter.predictions).toBeLessThanOrEqual(70);
    expect(r.improved).toBe(false);
  }, 60_000);

  it('stops at the deadline before an iteration that might not finish, keeping time for the holdout', async () => {
    // Each iteration takes a minute on this clock; with 2.5 minutes left after the first, a second doesn't fit.
    let t = 0;
    const r = await optimize(
      { gateway: gateway(), runDir: tmp(), log: () => {}, now: () => (t += 60_000), deadline: 150_000 },
      spec,
      instances,
    );
    expect(r.state.stopReason).toMatch(/time limit/);
    expect(r.state.iteration).toBe(1);
  }, 60_000);

  it('samples parents from the Pareto front', () => {
    const mk = (hash: string, scores: Record<string, number>) => ({
      candidate: { hash } as never,
      parent: null,
      iteration: 0,
      component: null,
      valScores: scores,
      valMean: 0,
      valFailures: 0,
    });
    const a = mk('a', { x: 1, y: 0 });
    const b = mk('b', { x: 0, y: 1 });
    const dominated = mk('c', { x: 0, y: 0 });
    const seen = new Set<string>();
    let u = 0;
    for (let i = 0; i < 40; i++)
      seen.add(sampleParent([a, b, dominated], ['x', 'y'], () => (u = (u + 0.37) % 1)).candidate.hash);
    expect([...seen].sort()).toEqual(['a', 'b']);
  });

  it("keeps an LLM winner's reasoning settings with its model in the variant snippet (ADR-0041)", () => {
    const snippet = (predictor: string, v: string) =>
      variantSnippet(
        {
          suggestedVersion: v,
          best: { candidate: resolveCandidate({ predictor }) },
          state: { spec: { name: 'x' } },
        } as never,
        'RUN',
      )!;
    const qwen = snippet('llm:qwen/qwen3.8-flash@predict.v2', 'predict.v3');
    expect(qwen).toContain('harness: {"keyEnum":true,"labelKeys":true},');
    expect(qwen).toContain('"qwen/qwen3.8-flash":{"reasoningMaxTokens":1024,"maxTokens":2048}');
    // The other models keep their predict.v2 settings, so the winner can replace predict.v2 on every shadow.
    expect(qwen).toContain('"xiaomi/mimo-v2.6-flash":{"reasoningMaxTokens":1024,"maxTokens":2048}');
    expect(qwen).toContain('"deepseek/deepseek-v4.1-flash":{"reasoningEffort":"low","maxTokens":6000}');
    expect(snippet('llm:qwen/qwen3.8-flash', 'predict.v3')).toContain('harness: {},');
    expect(snippet('llm:qwen/qwen3.8-flash', 'predict.v3')).not.toContain('modelHarness');
    // A change that isn't reasoning or a cap describes the prompt, so it is shared by every model (finding: a
    // `reasoned` schema scoped to one model would leave the others on `probs` with rewritten components).
    const reasoned = (predictor: string) =>
      variantSnippet(
        {
          suggestedVersion: 'predict.v3',
          best: {
            candidate: resolveCandidate({ predictor, harness: { schema: 'reasoned', maxTokens: 5000 } }),
          },
          state: { spec: { name: 'x' } },
        } as never,
        'RUN',
      )!;
    const fromV1 = reasoned('llm:deepseek/deepseek-v4.1-flash');
    expect(fromV1).toContain('harness: {"schema":"reasoned"},');
    expect(fromV1).toContain('modelHarness: {"deepseek/deepseek-v4.1-flash":{"maxTokens":5000}},');
    const fromV2 = reasoned('llm:deepseek/deepseek-v4.1-flash@predict.v2');
    expect(fromV2).toContain('harness: {"keyEnum":true,"labelKeys":true,"schema":"reasoned"},');
    expect(fromV2).toContain('"deepseek/deepseek-v4.1-flash":{"reasoningEffort":"low","maxTokens":5000}');
    expect(fromV2).toContain('"qwen/qwen3.8-flash":{"reasoningMaxTokens":1024,"maxTokens":2048}');
    const jev = snippet('jev:typesafe/jev-1.13@jev-predict.v2', 'jev-predict.v3');
    expect(jev).toContain('harness: {"calibrationTemperature":4},');
    expect(jev).not.toContain('modelHarness');
  });

  it('renders an optimize report with the verdict and the changed components', async () => {
    const r = await optimize({ gateway: gateway(), runDir: tmp(), log: () => {} }, spec, instances);
    const md = renderReport({
      id: 'R',
      name: 'test run',
      spec: { kind: 'optimize', seed: 's' },
      datasetHash: 'h',
      status: 'done',
      metrics: {
        verdict: r.verdict,
        stopReason: r.state.stopReason,
        split: { by: r.state.split.by, train: 1, val: 1, holdout: 1 },
        noise: r.state.noise,
        spend: r.state.meter,
        iterations: r.state.iteration,
        outcomes: {},
        poolSize: r.state.pool.length,
        val: r.val,
        holdout: r.holdout,
        best: { label: 'b', components: r.bestInput.components, harness: {} },
        suggestedVersion: r.suggestedVersion,
      },
      r2ReportKey: null,
      createdAt: 0,
    });
    expect(md).toContain('**Verdict.** Improved');
    expect(md).toContain('### jev.instructions');
    expect(md).toContain(nextVersion('decision'));
    // Aggregates and prompt text only: no question from the data.
    for (const i of instances.slice(0, 20)) expect(md).not.toContain(i.question.prompt);
  }, 60_000);
});
