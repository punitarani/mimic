import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ComponentId,
  componentProblems,
  componentReadBy,
  DEFAULT_PROMPT_VERSION,
  type Gateway,
  INCUMBENT_HARNESS,
  PER_MODEL_HARNESS_KEYS,
  type PerModelHarness,
  PREDICT_PROMPTS,
  type PredictHarness,
  resolvePredictPrompt,
  seededRng,
  shuffle,
  unitHash,
} from '@mimic/core';
import {
  BudgetStop,
  type Candidate,
  type CandidateInput,
  changedComponents,
  changedHarness,
  type EvalRecord,
  evaluateCandidate,
  Meter,
  type Metrics,
  metricsOf,
  noiseSd,
  OutageStop,
  type PairedDelta,
  pairedDelta,
  resolveCandidate,
  withComponent,
} from './evaluate';
import { type EvalInstance, personLabel } from './instances';
import { leakageProblems, leakCorpus, proposeComponent, reflectiveCases } from './reflect';

export interface OptimizeSpec {
  name: string;
  seed: CandidateInput;
  /** Components the reflection model may rewrite, round-robin. */
  components: ComponentId[];
  reflectionModel: string;
  /** Budget in predictions actually made (cache hits are free), GEPA's metric calls. */
  maxMetricCalls: number;
  maxUsd: number;
  minibatch: number;
  valSize: number;
  holdoutSize: number;
  maxIterations: number;
  /** Re-evaluate the seed on the validation set to measure the noise floor (costs one more validation pass). */
  noise: boolean;
  concurrency: number;
  rngSeed: string;
}

export const DEFAULT_COMPONENTS: Record<'jev' | 'llm', ComponentId[]> = {
  jev: ['jev.instructions', 'jev.choice'],
  llm: ['predict.system', 'predict.user'],
};

interface PoolEntry {
  candidate: Candidate;
  parent: string | null;
  iteration: number;
  component: ComponentId | null;
  valScores: Record<string, number>;
  valMean: number;
  valFailures: number;
}

interface HistoryEntry {
  iteration: number;
  parent: string;
  component: ComponentId;
  outcome: 'accepted' | 'rejected' | 'invalid' | 'duplicate' | 'error';
  detail: string;
  parentMinibatch?: number;
  childMinibatch?: number;
  child?: string;
}

interface OptimizeState {
  version: 1;
  spec: OptimizeSpec;
  split: { train: string[]; val: string[]; holdout: string[]; by: 'person' | 'question' };
  pool: PoolEntry[];
  history: HistoryEntry[];
  noise: { sd: number; minibatchMargin: number; valMargin: number } | null;
  meter: { usd: number; predictions: number; reflections: number; reflectionUsd: number };
  iteration: number;
  stopReason: string | null;
}

export interface OptimizeResult {
  state: OptimizeState;
  seed: PoolEntry;
  best: PoolEntry;
  val: {
    seed: Metrics;
    best: Metrics;
    delta: PairedDelta;
    logLossDelta: PairedDelta;
    byPerson: Record<string, PairedDelta>;
  };
  /** `accuracyDelta` is the paired item-accuracy change (absent in results from before ADR-0048). */
  holdout: { seed: Metrics; best: Metrics; delta: PairedDelta; accuracyDelta?: PairedDelta } | null;
  /** True only when the validation gain beats noise and replicates on the holdout (ADR-0048). */
  improved: boolean;
  verdict: string;
  suggestedVersion: string | null;
  bestInput: CandidateInput;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Splits dev instances into train (minibatches for reflection) and val (Pareto scores, acceptance); test people are
 * the holdout, evaluated once at the end (PLAN §12.4: never tuned on). With six or more dev people the split is by
 * person, so validation measures generalization to new people; with fewer it is by question.
 */
export function splitInstances(
  instances: EvalInstance[],
  spec: Pick<OptimizeSpec, 'valSize' | 'holdoutSize' | 'rngSeed'>,
) {
  const dev = instances.filter((i) => i.split === 'dev');
  const people = [...new Set(dev.map((i) => i.mimicId))];
  const by: 'person' | 'question' = people.length >= 6 ? 'person' : 'question';
  // By person: a balanced, seeded half of the people validate (never all on one side). By question: a seeded coin.
  const valPeople = new Set(
    [...people]
      .sort((a, b) => unitHash(`gepa:${spec.rngSeed}:${a}`) - unitHash(`gepa:${spec.rngSeed}:${b}`))
      .slice(0, Math.ceil(people.length / 2)),
  );
  const isVal = (i: EvalInstance) =>
    by === 'person' ? valPeople.has(i.mimicId) : unitHash(`gepa:${spec.rngSeed}:${i.id}`) < 0.5;
  const rng = seededRng(`split:${spec.rngSeed}`);
  const val = shuffle(dev.filter(isVal), rng).slice(0, spec.valSize);
  const train = dev.filter((i) => !isVal(i));
  const holdout = shuffle(
    instances.filter((i) => i.split === 'test'),
    rng,
  ).slice(0, spec.holdoutSize);
  return { train, val, holdout, by };
}

/** GEPA's candidate selection: sample from the per-instance Pareto front, weighted by instances won. */
export function sampleParent(pool: PoolEntry[], valIds: string[], rng: () => number): PoolEntry {
  if (pool.length === 1) return pool[0]!;
  const wins = new Map<string, number>();
  for (const id of valIds) {
    const best = Math.max(...pool.map((p) => p.valScores[id] ?? Number.NEGATIVE_INFINITY));
    for (const p of pool)
      if ((p.valScores[id] ?? Number.NEGATIVE_INFINITY) >= best - 1e-9)
        wins.set(p.candidate.hash, (wins.get(p.candidate.hash) ?? 0) + 1);
  }
  // Drop candidates dominated on every instance by another front member.
  const front = pool.filter((p) => wins.has(p.candidate.hash));
  const nondominated = front.filter(
    (p) =>
      !front.some(
        (q) =>
          q !== p &&
          valIds.every((id) => (q.valScores[id] ?? -1e9) >= (p.valScores[id] ?? -1e9)) &&
          valIds.some((id) => (q.valScores[id] ?? -1e9) > (p.valScores[id] ?? -1e9)),
      ),
  );
  const cands = nondominated.length ? nondominated : front;
  const total = cands.reduce((a, p) => a + (wins.get(p.candidate.hash) ?? 0), 0);
  let u = rng() * total;
  for (const p of cands) {
    u -= wins.get(p.candidate.hash) ?? 0;
    if (u <= 0) return p;
  }
  return cands.at(-1)!;
}

function entry(
  c: Candidate,
  recs: EvalRecord[],
  parent: string | null,
  iteration: number,
  component: ComponentId | null,
): PoolEntry {
  return {
    candidate: c,
    parent,
    iteration,
    component,
    valScores: Object.fromEntries(recs.map((r) => [r.instanceId, r.value])),
    valMean: mean(recs.map((r) => r.value)),
    valFailures: recs.filter((r) => !r.ok).length,
  };
}

/** The next free version ID for a winner, e.g. `predict.v2` or `jev-predict.v2`. */
export function nextVersion(kind: 'jev' | 'llm'): string {
  const stem = kind === 'jev' ? 'jev-predict' : 'predict';
  let n = 2;
  while (PREDICT_PROMPTS[`${stem}.v${n}`]) n++;
  return `${stem}.v${n}`;
}

export interface OptimizeDeps {
  gateway: Gateway;
  runDir: string;
  log: (line: string) => void;
  /** Wall-clock deadline (ms) for this invocation: no iteration starts that might not finish, holdout included. */
  deadline?: number;
  now?: () => number;
}

/**
 * GEPA-style reflective optimization of prediction prompt components (docs/OPTIMIZATION.md §6). Resumable: state
 * and the evaluation cache live in `runDir`, and a re-run with the same directory continues where it stopped.
 */
export async function optimize(
  deps: OptimizeDeps,
  spec: OptimizeSpec,
  instances: EvalInstance[],
): Promise<OptimizeResult> {
  mkdirSync(deps.runDir, { recursive: true });
  const statePath = join(deps.runDir, 'state.json');
  const cachePath = join(deps.runDir, 'cache.jsonl');
  const byId = new Map(instances.map((i) => [i.id, i]));
  const cache = new Map<string, EvalRecord>();
  if (existsSync(cachePath))
    for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as EvalRecord;
      if (byId.has(r.instanceId)) cache.set(`${r.candidate}|${r.instanceId}`, r);
    }
  const persist = (recs: EvalRecord[]) => {
    if (recs.length)
      appendFileSync(cachePath, `${recs.map((r) => JSON.stringify({ ...r, raw: undefined })).join('\n')}\n`);
  };

  const seedCandidate = resolveCandidate(spec.seed);
  for (const id of spec.components)
    if (!componentReadBy(id, seedCandidate.prompt))
      throw new Error(
        `${id} is not read by this ${seedCandidate.kind} predictor${id === 'state.evidence.line' ? ' (Jev reads it only with harness.jevState "text")' : ''}`,
      );
  const split = splitInstances(instances, spec);
  if (!split.val.length || !split.train.length)
    throw new Error(
      `need dev instances for both train and val (have ${split.train.length} train, ${split.val.length} val)`,
    );

  let state: OptimizeState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as OptimizeState;
    // A run that stopped before the seed was scored has an empty pool; its saved spec still names the seed.
    const savedSeed = state.pool[0]?.candidate.hash ?? resolveCandidate(state.spec.seed).hash;
    if (savedSeed !== seedCandidate.hash) throw new Error(`${statePath} belongs to another seed`);
    state.spec = {
      ...state.spec,
      maxMetricCalls: spec.maxMetricCalls,
      maxUsd: spec.maxUsd,
      maxIterations: spec.maxIterations,
    };
    state.stopReason = null;
    deps.log(`resuming at iteration ${state.iteration} with ${state.pool.length} candidates`);
  } else {
    state = {
      version: 1,
      spec,
      split: {
        train: split.train.map((i) => i.id),
        val: split.val.map((i) => i.id),
        holdout: split.holdout.map((i) => i.id),
        by: split.by,
      },
      pool: [],
      history: [],
      noise: null,
      meter: { usd: 0, predictions: 0, reflections: 0, reflectionUsd: 0 },
      iteration: 0,
      stopReason: null,
    };
  }
  // After a resume the saved spec rules, with the caps from this invocation (merged above).
  const run = state.spec;
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((i): i is EvalInstance => !!i);
  const train = pick(state.split.train);
  const val = pick(state.split.val);
  const holdout = pick(state.split.holdout);
  // Exports re-salt mimic IDs, so a run directory only resumes against the data it was started on.
  const missing =
    state.split.train.length -
    train.length +
    (state.split.val.length - val.length) +
    (state.split.holdout.length - holdout.length);
  if (missing)
    throw new Error(
      `${missing} instances saved in ${deps.runDir} are not in this data (a new export re-salts IDs); start a new --run-dir`,
    );
  const meter = new Meter(run.maxUsd, run.maxMetricCalls);
  meter.usd = state.meter.usd;
  meter.predictions = state.meter.predictions;
  meter.reflections = state.meter.reflections;
  const save = () => {
    state.meter = {
      ...state.meter,
      usd: meter.usd,
      predictions: meter.predictions,
      reflections: meter.reflections,
    };
    writeFileSync(statePath, JSON.stringify(state, null, 1));
  };
  const evaluate: Evaluate = async (c, xs, opts = {}) => {
    const m = opts.meter ?? meter;
    const cached = new Set(xs.filter((i) => cache.has(`${c.hash}|${i.id}`)).map((i) => i.id));
    const go = (ys: EvalInstance[]) =>
      evaluateCandidate(c, ys, {
        gateway: deps.gateway,
        meter: m,
        cache,
        fresh: opts.fresh ?? false,
        concurrency: run.concurrency,
        purpose: 'eval.optimize',
      });
    try {
      const recs = await go(xs);
      // An outage must never become a score (it would decide acceptance, the Pareto front and the verdict): ask the
      // transport failures once more, then stop the run gracefully. Everything paid for is kept; resume later.
      const failed = xs.filter((_, j) => recs[j]!.transient);
      if (!failed.length) return recs;
      const again = new Map((await go(failed)).map((r) => [r.instanceId, r]));
      const merged = recs.map((r) => again.get(r.instanceId) ?? r);
      const still = merged.filter((r) => r.transient).length;
      if (still)
        throw new OutageStop(
          `provider outage: ${still} prediction(s) failed in transport twice (${merged.find((r) => r.transient)!.error}); resume with --run-dir later`,
        );
      return merged;
    } finally {
      if (m !== meter) {
        meter.usd += m.usd;
        meter.predictions += m.predictions;
      }
      // Also on a BudgetStop: records already paid for are kept, so a resumed run doesn't buy them again.
      if (!opts.fresh)
        persist(
          xs
            .filter((i) => !cached.has(i.id))
            .map((i) => cache.get(`${c.hash}|${i.id}`))
            .filter((r): r is EvalRecord => !!r),
        );
    }
  };
  const corpus = leakCorpus(instances);
  deps.log(
    `${instances.length} instances: ${train.length} train, ${val.length} val, ${holdout.length} holdout (split by ${state.split.by}); seed ${seedCandidate.label}`,
  );

  try {
    if (!state.pool.length) {
      const seedVal = await evaluate(seedCandidate, val);
      state.pool.push(entry(seedCandidate, seedVal, null, 0, null));
      deps.log(
        `seed val: log loss ${metricsOf(seedVal).logLoss.toFixed(4)}, accuracy ${(metricsOf(seedVal).itemAcc * 100).toFixed(1)}%`,
      );
      save();
    }
    if (!state.noise) {
      let sd = 0;
      if (run.noise) {
        const again = await evaluate(seedCandidate, val, { fresh: true });
        const first = Object.entries(state.pool[0]!.valScores).map(([instanceId, value]) => ({
          instanceId,
          value,
        }));
        sd = noiseSd(first, again);
      }
      state.noise = {
        sd,
        minibatchMargin: sd / Math.sqrt(run.minibatch),
        valMargin: (2 * sd) / Math.sqrt(val.length),
      };
      deps.log(
        `noise floor: per-instance SD ${sd.toFixed(4)}; minibatch margin ${state.noise.minibatchMargin.toFixed(4)}, val margin ${state.noise.valMargin.toFixed(4)}`,
      );
      save();
    }

    const rng = seededRng(`gepa:${run.rngSeed}:${state.iteration}`);
    let reflectionErrors = 0;
    const now = deps.now ?? Date.now;
    let iterationStart: number | null = null;
    let slowestMs = 0;
    while (state.iteration < run.maxIterations) {
      // Stop before an iteration that might not finish in time, keeping as long again for the holdout check.
      const t = now();
      if (iterationStart !== null) slowestMs = Math.max(slowestMs, t - iterationStart);
      iterationStart = t;
      if (deps.deadline !== undefined && t + 2 * slowestMs > deps.deadline) {
        state.stopReason = `time limit: the next iteration could run past the deadline (slowest so far ${Math.round(slowestMs / 1000)} s)`;
        break;
      }
      // Stop before an iteration that could not be validated within the budget.
      const needed = 2 * run.minibatch + val.length;
      if (meter.predictions + needed > run.maxMetricCalls) {
        state.stopReason = `metric-call budget: ${meter.predictions} used, an iteration needs up to ${needed}`;
        break;
      }
      const perPrediction = meter.predictions
        ? (meter.usd - state.meter.reflectionUsd) / meter.predictions
        : 0;
      // Per proposal (a proposal may take a repair turn). Before the first one the cost is unknown; after every
      // proposal the cap is checked again before anything else is spent.
      const proposals = state.history.filter((h) => h.outcome !== 'error').length;
      const perReflection = proposals ? state.meter.reflectionUsd / proposals : 0;
      if (meter.usd + perPrediction * needed + perReflection > run.maxUsd) {
        state.stopReason = `spend cap: $${meter.usd.toFixed(4)} spent, the next iteration could cost ~$${(perPrediction * needed + perReflection).toFixed(4)}`;
        break;
      }
      state.iteration++;
      const it = state.iteration;
      const parent = sampleParent(state.pool, state.split.val, rng);
      const component = run.components[(it - 1) % run.components.length]!;
      // One person per minibatch, so no reflection prompt mixes people's answers (invariant 8).
      const counts = new Map<string, number>();
      for (const i of train) counts.set(i.mimicId, (counts.get(i.mimicId) ?? 0) + 1);
      const enough = [...counts.keys()].filter((p) => counts.get(p)! >= Math.min(3, run.minibatch));
      const people = enough.length ? enough : [...counts.keys()];
      const person = people[Math.floor(rng() * people.length)]!;
      const batch = shuffle(
        train.filter((i) => i.mimicId === person),
        rng,
      ).slice(0, run.minibatch);
      // The margin is the noise of this batch's mean, so a person with few questions needs a bigger gain.
      const margin = state.noise.sd / Math.sqrt(batch.length);
      const parentRecs = await evaluate(parent.candidate, batch);
      const parentScore = mean(parentRecs.map((r) => r.value));
      const log = (h: Omit<HistoryEntry, 'iteration' | 'parent' | 'component'>) => {
        state.history.push({ iteration: it, parent: parent.candidate.hash, component, ...h });
        deps.log(
          `#${it} ${component} ← ${parent.candidate.label}: ${h.outcome}${h.detail ? ` (${h.detail})` : ''}`,
        );
        save();
      };
      const check = (t: string) => [
        ...componentProblems(component, t),
        ...leakageProblems(t, parent.candidate.prompt.components[component], corpus),
      ];
      let proposal: Awaited<ReturnType<typeof proposeComponent>>;
      try {
        proposal = await proposeComponent(
          deps.gateway,
          run.reflectionModel,
          parent.candidate,
          component,
          reflectiveCases(byId, parentRecs),
          check,
        );
        meter.usd += proposal.costUsd;
        meter.reflections += proposal.calls;
        state.meter.reflectionUsd += proposal.costUsd;
        reflectionErrors = 0;
        meter.check();
      } catch (e) {
        if (e instanceof BudgetStop) throw e;
        reflectionErrors++;
        log({ outcome: 'error', detail: `reflection failed: ${(e as Error).message.slice(0, 200)}` });
        if (reflectionErrors >= 3) {
          state.stopReason = 'the reflection model failed three times in a row';
          break;
        }
        continue;
      }
      const text = proposal.text;
      if (!text || proposal.problems.length) {
        log({ outcome: 'invalid', detail: proposal.problems.join('; ') });
        continue;
      }
      const child = withComponent(parent.candidate, component, text, `#${it} ${component}`);
      if (state.pool.some((p) => p.candidate.hash === child.hash)) {
        log({ outcome: 'duplicate', detail: 'same text as a candidate already in the pool' });
        continue;
      }
      const childRecs = await evaluate(child, batch);
      const childScore = mean(childRecs.map((r) => r.value));
      if (childScore - parentScore <= margin) {
        log({
          outcome: 'rejected',
          detail: `minibatch ${childScore.toFixed(3)} vs parent ${parentScore.toFixed(3)} (margin ${margin.toFixed(3)}, n ${batch.length})`,
          parentMinibatch: parentScore,
          childMinibatch: childScore,
        });
        continue;
      }
      const childVal = await evaluate(child, val);
      const e = entry(child, childVal, parent.candidate.hash, it, component);
      state.pool.push(e);
      log({
        outcome: 'accepted',
        detail: `minibatch ${childScore.toFixed(3)} vs ${parentScore.toFixed(3)}; val ${e.valMean.toFixed(4)} (seed ${state.pool[0]!.valMean.toFixed(4)})`,
        parentMinibatch: parentScore,
        childMinibatch: childScore,
        child: child.hash,
      });
    }
    if (!state.stopReason) state.stopReason = `iteration limit ${run.maxIterations}`;
  } catch (e) {
    if (!(e instanceof BudgetStop)) {
      save();
      throw e;
    }
    state.stopReason = e.message;
  }
  save();
  deps.log(`stopped: ${state.stopReason}`);
  if (!state.pool.length)
    throw new Error(
      `stopped before the seed was scored on validation (${state.stopReason}); raise the caps and resume with --run-dir ${deps.runDir}`,
    );
  const result = await finish(deps, state, cache, val, holdout, evaluate);
  save();
  return result;
}

type Evaluate = (
  c: Candidate,
  xs: EvalInstance[],
  opts?: { fresh?: boolean; meter?: Meter },
) => Promise<EvalRecord[]>;

async function finish(
  deps: OptimizeDeps,
  state: OptimizeState,
  cache: Map<string, EvalRecord>,
  val: EvalInstance[],
  holdout: EvalInstance[],
  evaluate: Evaluate,
): Promise<OptimizeResult> {
  const seed = state.pool[0]!;
  const maxFailures = seed.valFailures + Math.ceil(0.05 * val.length);
  const best = state.pool
    .filter((p) => p.valFailures <= maxFailures)
    .reduce((a, b) => (b.valMean > a.valMean ? b : a), seed);
  const recsOf = (p: PoolEntry, xs: EvalInstance[]) =>
    xs.map((i) => cache.get(`${p.candidate.hash}|${i.id}`)).filter((r): r is EvalRecord => !!r);
  const seedVal = recsOf(seed, val);
  const bestVal = recsOf(best, val);
  const delta = pairedDelta(seedVal, bestVal, 'value', 'val');
  const byPerson: Record<string, PairedDelta> = {};
  for (const m of new Set(val.map((i) => i.mimicId))) {
    const s = seedVal.filter((r) => r.mimicId === m);
    byPerson[personLabel(m)] = pairedDelta(
      s,
      bestVal.filter((r) => r.mimicId === m),
      'value',
      m,
    );
  }
  let holdoutOut: OptimizeResult['holdout'] = null;
  let holdoutError: string | null = null;
  if (holdout.length && best !== seed) {
    // The holdout is spent once, after selection, on the two candidates that matter (winner's curse, §3.2). The caps
    // bound the search; this final check runs past them (two passes of at most holdoutSize predictions).
    try {
      const s = await evaluate(seed.candidate, holdout, { meter: new Meter() });
      const b = await evaluate(best.candidate, holdout, { meter: new Meter() });
      holdoutOut = {
        seed: metricsOf(s),
        best: metricsOf(b),
        delta: pairedDelta(s, b, 'value', 'holdout'),
        accuracyDelta: pairedDelta(s, b, 'itemAcc', 'holdout-acc'),
      };
    } catch (e) {
      if (!(e instanceof OutageStop)) throw e;
      holdoutError = e.message;
    }
  }
  const margin = state.noise?.valMargin ?? 0;
  const { improved, verdict } = judge({
    sameAsSeed: best === seed,
    holdoutError,
    val: delta,
    margin,
    holdout: holdoutOut,
  });
  const base = best.candidate.baseVersion;
  const bestInput: CandidateInput = {
    label: best.candidate.label,
    predictor: `${best.candidate.kind}:${best.candidate.model}${base === DEFAULT_PROMPT_VERSION[best.candidate.kind] ? '' : `@${base}`}`,
    components: changedComponents(best.candidate),
    harness: changedHarness(best.candidate),
  };
  deps.log(verdict);
  return {
    state,
    seed,
    best,
    val: {
      seed: metricsOf(seedVal),
      best: metricsOf(bestVal),
      delta,
      logLossDelta: pairedDelta(seedVal, bestVal, 'logLoss', 'val-ll'),
      byPerson,
    },
    holdout: holdoutOut,
    improved,
    verdict,
    suggestedVersion: improved ? nextVersion(best.candidate.kind) : null,
    bestInput,
  };
}

/**
 * The verdict on a run (ADR-0048). "Improved" needs a validation gain above the noise margin with a 90% CI above zero,
 * and a replication on the holdout: its paired gain above zero with 90% confidence, and item accuracy not lower with
 * 90% confidence. A validation gain that does not replicate is "Unconfirmed" and gets no suggested version.
 */
export function judge(x: {
  sameAsSeed: boolean;
  holdoutError: string | null;
  val: PairedDelta;
  margin: number;
  holdout: OptimizeResult['holdout'];
}): { improved: boolean; verdict: string } {
  const valGain = !x.sameAsSeed && x.val.mean > x.margin && x.val.ciLow > 0;
  const acc = x.holdout?.accuracyDelta;
  // An improvement has to replicate on people the search never saw (ADR-0048): with a handful of training people a
  // validation gain can be fitting them. The holdout gain must be above zero with 90% confidence, and holdout item
  // accuracy must not be lower with 90% confidence.
  const confirmed = !!x.holdout && x.holdout.delta.ciLow > 0 && (!acc || acc.ciHigh >= 0);
  const improved = valGain && !x.holdoutError && confirmed;
  const valText = `validation score +${x.val.mean.toFixed(4)} nats per question (90% CI ${x.val.ciLow.toFixed(4)} to ${x.val.ciHigh.toFixed(4)}), above the noise margin ${x.margin.toFixed(4)}`;
  const holdoutText = x.holdout
    ? `holdout ${x.holdout.delta.mean >= 0 ? '+' : ''}${x.holdout.delta.mean.toFixed(4)} (90% CI ${x.holdout.delta.ciLow.toFixed(4)} to ${x.holdout.delta.ciHigh.toFixed(4)})${acc ? `, item accuracy ${acc.mean >= 0 ? '+' : ''}${(acc.mean * 100).toFixed(1)} points` : ''}`
    : '';
  const verdict = x.sameAsSeed
    ? 'No candidate beat the seed on validation.'
    : x.holdoutError
      ? `Undecided: the holdout check hit a ${x.holdoutError}; resume with the same --run-dir to finish it.`
      : !valGain
        ? `Not shipped: the best candidate's gain (+${x.val.mean.toFixed(4)}, CI ${x.val.ciLow.toFixed(4)} to ${x.val.ciHigh.toFixed(4)}) is within noise (margin ${x.margin.toFixed(4)}).`
        : !x.holdout
          ? `Unconfirmed: ${valText}, but there are no test-split people to confirm it on. Not registered.`
          : x.holdout.delta.mean < -x.margin
            ? `Not shipped: it lost on the holdout (${x.holdout.delta.mean.toFixed(4)} nats per question) despite a validation gain of +${x.val.mean.toFixed(4)}.`
            : improved
              ? `Improved: ${valText}; confirmed on the holdout: ${holdoutText}.`
              : `Unconfirmed: ${valText}, but it did not replicate on the holdout: ${holdoutText}. Not registered: the gain may fit the training people only.`;
  return { improved, verdict };
}

/** A ready-to-paste `PREDICT_PROMPTS` entry for a winner (packages/core/src/components.ts). */
export function variantSnippet(r: OptimizeResult, runId: string): string | null {
  if (!r.suggestedVersion) return null;
  const v = r.suggestedVersion;
  const c = r.best.candidate;
  // A registered variant overrides the incumbent, not the seed's base variant, so diff against the incumbent.
  const incumbent = DEFAULT_PROMPT_VERSION[c.kind];
  // The seed variant's harness structure plus this run's changes. Reasoning control and caps are measured per model
  // (ADR-0041), so a change to them is scoped to the model it was optimized on, and the seed's entries for other
  // models are kept; any other harness change (schema, keys, calibration) describes the prompt and is shared.
  let harnessLines = `harness: ${JSON.stringify(changedHarness(c, incumbent))},`;
  if (c.kind === 'llm') {
    const base = c.baseVersion === incumbent ? undefined : PREDICT_PROMPTS[c.baseVersion];
    const seeded = resolvePredictPrompt(c.baseVersion, c.kind, c.model).harness;
    const shared: Partial<PredictHarness> = { ...base?.harness };
    const perModel: Record<string, PerModelHarness> = { ...base?.modelHarness };
    const own: PerModelHarness = { ...perModel[c.model] };
    for (const k of Object.keys(INCUMBENT_HARNESS) as Array<keyof PredictHarness>) {
      if (c.prompt.harness[k] === seeded[k]) continue;
      if ((PER_MODEL_HARNESS_KEYS as readonly string[]).includes(k))
        Object.assign(own, { [k]: c.prompt.harness[k] });
      else Object.assign(shared, { [k]: c.prompt.harness[k] });
    }
    if (Object.keys(own).length) perModel[c.model] = own;
    harnessLines = `harness: ${JSON.stringify(shared)},`;
    if (Object.keys(perModel).length) harnessLines += `\n    modelHarness: ${JSON.stringify(perModel)},`;
  }
  return `  '${v}': {
    id: '${v}',
    kind: '${c.kind}',
    title: ${JSON.stringify(`Optimized by ${r.state.spec.name}`)},
    components: ${JSON.stringify(changedComponents(c, incumbent), null, 2).replace(/\n/g, '\n    ')},
    ${harnessLines}
    source: ${JSON.stringify(`mimic-eval optimize run ${runId}`)},
  },`;
}
