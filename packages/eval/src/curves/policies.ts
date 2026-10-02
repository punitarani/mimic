import {
  type Distribution,
  entropy,
  normalizedEntropy,
  type PersonState,
  type Predictor,
  seededRng,
  shuffle,
  temperatureScale,
} from '@mimic/core';
import type { Meter } from '../optimize/evaluate';
import { mimicIdOf, questionOf, stateAfter, type TwinItem, type TwinPerson } from './data';
import type { PersonaPosterior, Population } from './population';

/**
 * Selection policies for E9 (docs/CURVES.md §4). Each picks the next item from what is left of a person's pool,
 * from the person's state and, for some, the reference questions (R) or the population; none ever reads an answer
 * it hasn't been given, a target (T), or another dev or test person.
 */

/** Jev on raw probabilities, batched as production batches (questions sharing a state, at most 20 a request). */
export class JevOracle {
  requests = 0;
  constructor(
    private readonly predictor: Predictor,
    private readonly meter: Meter,
    private readonly maxQuestions = 20,
  ) {}

  /** Raw distributions over each item's option keys, in input order; null where Jev failed twice. */
  async predict(
    pid: string,
    state: PersonState,
    items: readonly TwinItem[],
  ): Promise<Array<Distribution | null>> {
    const qs = items.map((it, i) => ({ it, i, q: questionOf(it, mimicIdOf(pid), i + 1) }));
    // Chunked in a fixed order, so the same items from the same state are the same requests.
    const sorted = [...qs].sort((a, b) => (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0));
    const out = new Array<Distribution | null>(items.length).fill(null);
    const chunks: (typeof sorted)[] = [];
    for (let i = 0; i < sorted.length; i += this.maxQuestions)
      chunks.push(sorted.slice(i, i + this.maxQuestions));
    await Promise.all(
      chunks.map(async (chunk) => {
        this.meter.check();
        let res = await this.predictor.predict(
          state,
          chunk.map((c) => c.q),
        );
        this.requests++;
        let spent = res.reduce((a, r) => a + r.costUsd, 0);
        if (res.some((r) => !r.ok && r.errorKind !== 'output')) {
          res = await this.predictor.predict(
            state,
            chunk.map((c) => c.q),
          );
          this.requests++;
          spent += res.reduce((a, r) => a + r.costUsd, 0);
        }
        this.meter.usd += spent;
        this.meter.predictions += chunk.length;
        chunk.forEach((c, j) => {
          const r = res[j]!;
          if (r.ok) out[c.i] = r.dist;
        });
      }),
    );
    return out;
  }
}

export interface PolicyContext {
  person: TwinPerson;
  asked: readonly TwinItem[];
  /** What is left of the pool, in survey order. */
  remaining: readonly TwinItem[];
  state: PersonState;
  rng: () => number;
  jev: JevOracle;
  pop: Population | null;
  posterior: PersonaPosterior | null;
  /** Records the chosen item's selection score (its expected gain or entropy), for the stopping-rule analysis. */
  note?: (score: number) => void;
}

export interface Policy {
  readonly name: string;
  /** Keeps a persona posterior per person (updated by the runner after each answer). */
  readonly usesPopulation: boolean;
  /** The posterior's likelihood temper (`PersonaPosterior`); 1 when absent. */
  readonly beta?: number;
  next(ctx: PolicyContext): Promise<TwinItem>;
}

export interface PolicyKnobs {
  /** Random candidates whose entropy Jev scores in a step. */
  entropyShortlist: number;
  /** Candidates whose answers the lookahead tries. */
  lookaheadShortlist: number;
  /** Reference questions the lookahead predicts, sampled once per person. */
  referenceSize: number;
  /** Temperature on Jev's raw probabilities when planning (Jev's served temperature is 4). */
  tSel: number;
  /** Answers below this probability are not tried in the lookahead (the rest renormalised). */
  answerFloor: number;
  /** pop-static's probe train people. */
  staticProbes: number;
  /** Likelihood temper of the persona posterior a policy selects with (1: untempered). */
  beta: number;
  /**
   * What the lookahead and the persona posterior aim at: `R`, the wave 4 reference questions (the kind of decision
   * that will be scored), or `pool`, a fixed sample of the person's own pool questions (no knowledge of the targets).
   */
  reference: 'R' | 'pool';
}

export const POLICY_DEFAULTS: PolicyKnobs = {
  entropyShortlist: 60,
  lookaheadShortlist: 6,
  referenceSize: 20,
  tSel: 4,
  answerFloor: 0.05,
  staticProbes: 40,
  beta: 1,
  reference: 'R',
};

const argmaxBy = <T>(xs: readonly T[], f: (x: T) => number): T | undefined => {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    const s = f(x);
    if (s > bestScore + 1e-12) {
      bestScore = s;
      best = x;
    }
  }
  return best;
};

const randomOf = (xs: readonly TwinItem[], rng: () => number) => xs[Math.floor(rng() * xs.length)]!;

export const orderPolicy: Policy = {
  name: 'order',
  usesPopulation: false,
  next: async (ctx) => ctx.remaining[0]!,
};

export const randomPolicy: Policy = {
  name: 'random',
  usesPopulation: false,
  next: async (ctx) => randomOf(ctx.remaining, ctx.rng),
};

/** Round-robin over the survey's blocks (demographics, personality, cognitive tests, economic preferences). */
export const stratifiedPolicy: Policy = {
  name: 'stratified',
  usesPopulation: false,
  next: async (ctx) => {
    const blocks = [...new Set(ctx.person.pool.map((i) => i.block))];
    for (let s = 0; s < blocks.length; s++) {
      const block = blocks[(ctx.asked.length + s) % blocks.length]!;
      const left = ctx.remaining.filter((i) => i.block === block);
      if (left.length) return randomOf(left, ctx.rng);
    }
    return randomOf(ctx.remaining, ctx.rng);
  },
};

async function entropyShortlist(
  ctx: PolicyContext,
  knobs: PolicyKnobs,
): Promise<Array<{ item: TwinItem; dist: Distribution; h: number }>> {
  const cands = shuffle(ctx.remaining, ctx.rng).slice(0, knobs.entropyShortlist);
  const dists = await ctx.jev.predict(ctx.person.pid, ctx.state, cands);
  return cands
    .map((item, i) => {
      const d = dists[i];
      if (!d) return null;
      const scaled = temperatureScale(d, knobs.tSel);
      return { item, dist: scaled, h: normalizedEntropy(scaled) };
    })
    .filter((x): x is { item: TwinItem; dist: Distribution; h: number } => !!x);
}

/** Asks what Jev is least sure of: production's `voi` without hypotheses scores this (SELECTION.md §4). */
export function jevEntropyPolicy(knobs: PolicyKnobs): Policy {
  return {
    name: 'jev-entropy',
    usesPopulation: false,
    next: async (ctx) => {
      const scored = await entropyShortlist(ctx, knobs);
      const best = argmaxBy(scored, (x) => x.h);
      if (best) ctx.note?.(best.h);
      return best?.item ?? randomOf(ctx.remaining, ctx.rng);
    },
  };
}

/** The reference questions a person's lookahead predicts: a fixed sample, the same at every step. */
export function referenceSample(person: TwinPerson, knobs: PolicyKnobs, seed: string): TwinItem[] {
  const from = knobs.reference === 'pool' ? person.pool : person.reference;
  return shuffle(from, seededRng(`${seed}:ref:${knobs.reference}:${person.pid}`)).slice(
    0,
    knobs.referenceSize,
  );
}

/**
 * Jev's expected information about the reference from asking `item`: for each answer a it might get (weighted by
 * Jev's own q(a)), Jev predicts R from the state with that answer added; the gain is Σ_r H(Σ_a q(a)·p_r^a) −
 * Σ_a q(a)·H(p_r^a), the mutual information between the item's answer and each reference answer under Jev (never
 * negative, unlike the drop in entropy, which rewards answers that only make Jev more confident).
 */
export async function lookaheadGain(
  ctx: PolicyContext,
  item: TwinItem,
  q: Distribution,
  reference: readonly TwinItem[],
  knobs: PolicyKnobs,
): Promise<number> {
  const answers = Object.entries(q).filter(([, p]) => p >= knobs.answerFloor);
  const z = answers.reduce((a, [, p]) => a + p, 0);
  if (!answers.length || z <= 0) return 0;
  const preds = await Promise.all(
    answers.map(async ([a]) => {
      const state = stateAfter(ctx.person.pid, [...ctx.asked, { ...item, answer: a }]);
      return ctx.jev.predict(ctx.person.pid, state, reference);
    }),
  );
  let gain = 0;
  reference.forEach((r, i) => {
    const per = answers.map(([, p], j) => ({ w: p / z, d: preds[j]![i] }));
    if (per.some((x) => !x.d)) return;
    const keys = r.options.map((o) => o.key);
    const mix: Distribution = Object.fromEntries(keys.map((k) => [k, 0]));
    let cond = 0;
    for (const { w, d } of per) {
      const s = temperatureScale(d!, knobs.tSel);
      for (const k of keys) mix[k]! += w * (s[k] ?? 0);
      cond += w * entropy(s);
    }
    gain += Math.max(0, entropy(mix) - cond);
  });
  return gain;
}

/** Jev entropy shortlists the candidates; Jev's lookahead over the reference picks among them. */
export function jevEigPolicy(knobs: PolicyKnobs, seed: string): Policy {
  return {
    name: 'jev-eig',
    usesPopulation: false,
    next: async (ctx) => {
      const scored = await entropyShortlist(ctx, knobs);
      const short = [...scored].sort((a, b) => b.h - a.h).slice(0, knobs.lookaheadShortlist);
      if (!short.length) return randomOf(ctx.remaining, ctx.rng);
      const ref = referenceSample(ctx.person, knobs, seed);
      const gains = await Promise.all(short.map((s) => lookaheadGain(ctx, s.item, s.dist, ref, knobs)));
      const best = Math.max(...gains);
      ctx.note?.(best);
      return short[gains.indexOf(best)]!.item;
    },
  };
}

/** The reference keys the persona posterior aims at; a pool reference samples at least 30 pool questions. */
const popKeys = (ctx: PolicyContext, knobs: PolicyKnobs, seed: string) =>
  (knobs.reference === 'pool'
    ? referenceSample(ctx.person, { ...knobs, referenceSize: Math.max(knobs.referenceSize, 30) }, seed)
    : ctx.person.reference
  )
    .map((r) => r.key)
    .filter((k) => ctx.pop?.has(k));

/** The persona posterior's expected information about the reference, in closed form (no model calls). */
export function popEigPolicy(knobs: PolicyKnobs, seed: string): Policy {
  return {
    name: 'pop-eig',
    usesPopulation: true,
    beta: knobs.beta,
    next: async (ctx) => {
      if (!ctx.posterior || !ctx.pop) throw new Error('pop-eig needs the population');
      const refs = popKeys(ctx, knobs, seed);
      const w = ctx.posterior.weights();
      let best: TwinItem | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const i of ctx.remaining) {
        if (!ctx.pop.has(i.key)) continue;
        const g = ctx.posterior.eig(i.key, refs, w);
        if (g > bestScore + 1e-12) {
          bestScore = g;
          best = i;
        }
      }
      if (best) ctx.note?.(bestScore);
      return best ?? randomOf(ctx.remaining, ctx.rng);
    },
  };
}

/** The best fixed questionnaire for the population (`staticSequence`), the same for everyone. */
export function popStaticPolicy(sequence: readonly string[]): Policy {
  return {
    name: 'pop-static',
    usesPopulation: false,
    next: async (ctx) => {
      const left = new Map(ctx.remaining.map((i) => [i.key, i]));
      for (const key of sequence) {
        const it = left.get(key);
        if (it) return it;
      }
      return randomOf(ctx.remaining, ctx.rng);
    },
  };
}

/** The population shortlists; Jev's lookahead picks among the shortlist. */
export function hybridPolicy(knobs: PolicyKnobs, seed: string): Policy {
  return {
    name: 'hybrid',
    usesPopulation: true,
    beta: knobs.beta,
    next: async (ctx) => {
      if (!ctx.posterior || !ctx.pop) throw new Error('hybrid needs the population');
      const refs = popKeys(ctx, knobs, seed);
      const w = ctx.posterior.weights();
      const short = ctx.remaining
        .filter((i) => ctx.pop!.has(i.key))
        .map((i) => ({ i, g: ctx.posterior!.eig(i.key, refs, w) }))
        .sort((a, b) => b.g - a.g)
        .slice(0, knobs.lookaheadShortlist)
        .map((x) => x.i);
      if (!short.length) return randomOf(ctx.remaining, ctx.rng);
      const qs = await ctx.jev.predict(ctx.person.pid, ctx.state, short);
      const ref = referenceSample(ctx.person, knobs, seed);
      const gains = await Promise.all(
        short.map((it, i) =>
          qs[i]
            ? lookaheadGain(ctx, it, temperatureScale(qs[i]!, knobs.tSel), ref, knobs)
            : Promise.resolve(-1),
        ),
      );
      const best = Math.max(...gains);
      ctx.note?.(best);
      return short[gains.indexOf(best)]!;
    },
  };
}

export const POLICY_NAMES = [
  'order',
  'random',
  'stratified',
  'jev-entropy',
  'pop-static',
  'pop-eig',
  'jev-eig',
  'hybrid',
] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

/**
 * A policy spec: a base policy, optionally after an opening block from the static questionnaire and with knobs of
 * its own, e.g. `jev-eig`, `jev-eig[ref=pool,tsel=1]`, `open10-pop-eig`. The spec is the policy's name in the report
 * and in its random seed.
 */
export interface PolicySpec {
  spec: string;
  base: PolicyName;
  /** Items taken from the static questionnaire before the base policy starts. */
  open: number;
  knobs: Partial<PolicyKnobs>;
}

const KNOB_KEYS: Record<string, keyof PolicyKnobs> = {
  ent: 'entropyShortlist',
  short: 'lookaheadShortlist',
  refsize: 'referenceSize',
  tsel: 'tSel',
  floor: 'answerFloor',
  beta: 'beta',
  ref: 'reference',
};

export function parsePolicySpec(spec: string): PolicySpec {
  const m = /^(?:open(\d+)-)?([a-z-]+)(?:\[([^\]]*)\])?$/.exec(spec.trim());
  if (!m || !(POLICY_NAMES as readonly string[]).includes(m[2]!))
    throw new Error(
      `unknown policy ${spec} (known: ${POLICY_NAMES.join(', ')}; e.g. open10-jev-eig[ref=pool,tsel=1])`,
    );
  const knobs: Partial<PolicyKnobs> = {};
  for (const kv of (m[3] ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=').map((x) => x.trim());
    const key = KNOB_KEYS[k ?? ''];
    if (!key || v === undefined || v === '')
      throw new Error(`${spec}: unknown knob ${kv} (${Object.keys(KNOB_KEYS).join(', ')})`);
    if (key === 'reference') {
      if (v !== 'R' && v !== 'pool') throw new Error(`${spec}: ref is R or pool`);
      knobs.reference = v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${spec}: ${k} must be a number`);
      knobs[key] = n;
    }
  }
  return { spec: spec.trim(), base: m[2] as PolicyName, open: Number(m[1] ?? 0), knobs };
}

/** Policies that need the train population (to select, or for the static opening block). */
export const needsPopulation = (s: PolicySpec) =>
  s.base === 'pop-eig' || s.base === 'pop-static' || s.base === 'hybrid' || s.open > 0;

/** The first `n` items from the static questionnaire, then `inner`. */
export function openedPolicy(name: string, n: number, sequence: readonly string[], inner: Policy): Policy {
  const opening = popStaticPolicy(sequence);
  return {
    name,
    usesPopulation: inner.usesPopulation,
    ...(inner.beta !== undefined ? { beta: inner.beta } : {}),
    next: (ctx) => (ctx.asked.length < n ? opening.next(ctx) : inner.next(ctx)),
  };
}
