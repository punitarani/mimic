import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPONENT_SPECS,
  type ComponentId,
  componentProblems,
  DEFAULT_PROMPT_VERSION,
  type Gateway,
  PREDICT_PROMPTS,
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
  holdout: { seed: Metrics; best: Metrics; delta: PairedDelta } | null;
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
  const people = new Set(dev.map((i) => i.mimicId));
  const by: 'person' | 'question' = people.size >= 6 ? 'person' : 'question';
  const isVal = (i: EvalInstance) =>
    unitHash(`gepa:${spec.rngSeed}:${by === 'person' ? i.mimicId : i.id}`) < 0.5;
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
    if (!COMPONENT_SPECS[id].kinds.includes(seedCandidate.kind))
      throw new Error(`${id} is not read by ${seedCandidate.kind} predictors`);
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
    try {
      return await evaluateCandidate(c, xs, {
        gateway: deps.gateway,
        meter: m,
        cache,
        fresh: opts.fresh ?? false,
        concurrency: run.concurrency,
        purpose: 'eval.optimize',
      });
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
    while (state.iteration < run.maxIterations) {
      // Stop before an iteration that could not be validated within the budget.
      const needed = 2 * run.minibatch + val.length;
      if (meter.predictions + needed > run.maxMetricCalls) {
        state.stopReason = `metric-call budget: ${meter.predictions} used, an iteration needs up to ${needed}`;
        break;
      }
      const perPrediction = meter.predictions
        ? (meter.usd - state.meter.reflectionUsd) / meter.predictions
        : 0;
      const perReflection = meter.reflections ? state.meter.reflectionUsd / meter.reflections : 0;
      if (meter.usd + perPrediction * needed + perReflection > run.maxUsd) {
        state.stopReason = `spend cap: $${meter.usd.toFixed(4)} spent, the next iteration could cost ~$${(perPrediction * needed + perReflection).toFixed(4)}`;
        break;
      }
      state.iteration++;
      const it = state.iteration;
      const parent = sampleParent(state.pool, state.split.val, rng);
      const component = run.components[(it - 1) % run.components.length]!;
      const batch = shuffle(train, rng).slice(0, run.minibatch);
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
      if (childScore - parentScore <= state.noise.minibatchMargin) {
        log({
          outcome: 'rejected',
          detail: `minibatch ${childScore.toFixed(3)} vs parent ${parentScore.toFixed(3)} (margin ${state.noise.minibatchMargin.toFixed(3)})`,
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
  if (holdout.length && best !== seed) {
    // The holdout is spent once, after selection, on the two candidates that matter (winner's curse, §3.2). The caps
    // bound the search; this final check runs past them (two passes of at most holdoutSize predictions).
    const s = await evaluate(seed.candidate, holdout, { meter: new Meter() });
    const b = await evaluate(best.candidate, holdout, { meter: new Meter() });
    holdoutOut = { seed: metricsOf(s), best: metricsOf(b), delta: pairedDelta(s, b, 'value', 'holdout') };
  }
  const margin = state.noise?.valMargin ?? 0;
  const improved =
    best !== seed &&
    delta.mean > margin &&
    delta.ciLow > 0 &&
    (!holdoutOut || holdoutOut.delta.mean >= -margin);
  const verdict =
    best === seed
      ? 'No candidate beat the seed on validation.'
      : improved
        ? `Improved: validation score +${delta.mean.toFixed(4)} nats per question (90% CI ${delta.ciLow.toFixed(4)} to ${delta.ciHigh.toFixed(4)}), above the noise margin ${margin.toFixed(4)}${holdoutOut ? `; holdout ${holdoutOut.delta.mean >= 0 ? '+' : ''}${holdoutOut.delta.mean.toFixed(4)}` : '; no test-split people to hold out'}.`
        : `Not shipped: the best candidate's gain (+${delta.mean.toFixed(4)}, CI ${delta.ciLow.toFixed(4)} to ${delta.ciHigh.toFixed(4)}) is within noise (margin ${margin.toFixed(4)})${holdoutOut && holdoutOut.delta.mean < -margin ? ' or it lost on the holdout' : ''}.`;
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

/** A ready-to-paste `PREDICT_PROMPTS` entry for a winner (packages/core/src/components.ts). */
export function variantSnippet(r: OptimizeResult, runId: string): string | null {
  if (!r.suggestedVersion) return null;
  const v = r.suggestedVersion;
  const c = r.best.candidate;
  // A registered variant overrides the incumbent, not the seed's base variant, so diff against the incumbent.
  const incumbent = DEFAULT_PROMPT_VERSION[c.kind];
  return `  '${v}': {
    id: '${v}',
    kind: '${c.kind}',
    title: ${JSON.stringify(`Optimized by ${r.state.spec.name}`)},
    components: ${JSON.stringify(changedComponents(c, incumbent), null, 2).replace(/\n/g, '\n    ')},
    harness: ${JSON.stringify(changedHarness(c, incumbent))},
    source: ${JSON.stringify(`mimic-eval optimize run ${runId}`)},
  },`;
}
