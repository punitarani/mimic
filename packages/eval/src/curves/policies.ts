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
import { mimicIdOf, questionOf, stateOf, type TwinItem, type TwinPerson } from './data';
import { cosine, textOf } from './embeddings';
import { PersonaPosterior, type Population, type Posterior } from './population';

/**
 * Selection policies for E9 (docs/CURVES.md §4). Each picks the next item from what is left of a person's pool,
 * from the person's state and, for some, the reference questions (R) or the population; none ever reads an answer
 * it hasn't been given, a target (T), or another dev or test person.
 */

/** Jev on raw probabilities, batched as production batches (questions sharing a state, at most 20 a request). */
export class JevOracle {
  requests = 0;
  /** Predictions asked for, and those that failed twice (an outage shows here first). */
  predictions = 0;
  failed = 0;
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
          this.predictions++;
          if (r.ok) out[c.i] = r.dist;
          else this.failed++;
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
  posterior: Posterior | null;
  /** Records the chosen item's selection score (its expected gain or entropy), for the stopping-rule analysis. */
  note?: (score: number) => void;
  /** Question text (`textOf`) → embedding, for the semantic policies. */
  vectors?: ReadonlyMap<string, number[]>;
}

export interface Policy {
  readonly name: string;
  /** Keeps a persona posterior per person (updated by the runner after each answer). */
  readonly usesPopulation: boolean;
  /** The posterior's likelihood temper (`PersonaPosterior`); 1 when absent. */
  readonly beta?: number;
  /** A posterior of the policy's own (over latent classes, `cls=K`); the train people's when absent. */
  readonly posteriorOf?: () => Posterior;
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
  /** `sem-ref`'s redundancy weight: relevance to R minus this times the closest question already asked. */
  mmr: number;
  /** Latent classes the persona posterior runs over (`classes.ts`); 0 runs it over the train people themselves. */
  classes: number;
  /** `jev-lift`: candidates measured (the top by population transfer, plus production's anchors). */
  liftShortlist: number;
  /** `jev-lift`: train people each candidate is measured on. */
  liftPeople: number;
  /**
   * What the lookahead and the persona posterior aim at: `R`, the wave 4 reference questions (the kind of decision
   * that will be scored), `pool`, a fixed sample of the person's own pool questions (no knowledge of the targets), or
   * `id`, the person themselves: which train person they answer like (persona posterior policies only).
   */
  reference: 'R' | 'pool' | 'id';
}

export const POLICY_DEFAULTS: PolicyKnobs = {
  entropyShortlist: 60,
  lookaheadShortlist: 6,
  referenceSize: 20,
  tSel: 4,
  answerFloor: 0.05,
  staticProbes: 40,
  beta: 1,
  mmr: 0.5,
  reference: 'R',
  classes: 0,
  liftShortlist: 60,
  liftPeople: 60,
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
  if (knobs.reference === 'id')
    throw new Error("ref=id is for the persona posterior's policies, not Jev's lookahead");
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
      const state = stateOf(ctx.person, [...ctx.asked, { ...item, answer: a }]);
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
    .filter((k) => ctx.posterior?.has(k) ?? ctx.pop?.has(k));

/** The persona posterior's expected information about the reference, in closed form (no model calls). */
export function popEigPolicy(knobs: PolicyKnobs, seed: string): Policy {
  return {
    name: 'pop-eig',
    usesPopulation: true,
    beta: knobs.beta,
    next: async (ctx) => {
      if (!ctx.posterior || !ctx.pop) throw new Error('pop-eig needs the population');
      const refs = knobs.reference === 'id' ? [] : popKeys(ctx, knobs, seed);
      const w = ctx.posterior.weights();
      let best: TwinItem | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const i of ctx.remaining) {
        if (!ctx.posterior.has(i.key)) continue;
        const g =
          knobs.reference === 'id' ? ctx.posterior.identity(i.key, w) : ctx.posterior.eig(i.key, refs, w);
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

/**
 * Production's population term, alone (`populationScore`, docs/SELECTION.md §7): the item whose answers people differ
 * on most (normalised entropy of the train people's answers). Information about the item itself, not about others.
 */
export const popEntropyPolicy: Policy = {
  name: 'pop-entropy',
  usesPopulation: true,
  next: async (ctx) => {
    if (!ctx.pop) throw new Error('pop-entropy needs the population');
    const prior = new PersonaPosterior(ctx.pop);
    const w = prior.weights();
    let best: TwinItem | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const i of ctx.remaining) {
      const p = prior.predictive(i.key, w);
      if (!p || p.length < 2) continue;
      const h = -[...p].reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0) / Math.log(p.length);
      if (h > bestScore + 1e-12) {
        bestScore = h;
        best = i;
      }
    }
    if (best) ctx.note?.(bestScore);
    return best ?? randomOf(ctx.remaining, ctx.rng);
  },
};

/**
 * An item statistic a cohort could store (aggregate-only, like `item_stats`): each item's information about the
 * reference under the unconditioned population, Σ_r I(A_c; A_r), ranked once and asked in that order. No
 * conditioning on the person and no redundancy check: the simplest portable form of `pop-eig`.
 */
export function popTransferPolicy(knobs: PolicyKnobs, seed: string): Policy {
  const rankings = new Map<string, Array<{ key: string; g: number }>>();
  return {
    name: 'pop-transfer',
    usesPopulation: true,
    next: async (ctx) => {
      if (!ctx.pop) throw new Error('pop-transfer needs the population');
      const refs = popKeys(ctx, knobs, seed);
      const sig = refs.join('|');
      let ranking = rankings.get(sig);
      if (!ranking) {
        const prior = new PersonaPosterior(ctx.pop);
        const w = prior.weights();
        ranking = ctx.person.pool
          .filter((i) => ctx.pop!.has(i.key))
          .map((i) => ({ key: i.key, g: prior.eig(i.key, refs, w) }))
          .sort((a, b) => b.g - a.g);
        rankings.set(sig, ranking);
      }
      const left = new Map(ctx.remaining.map((i) => [i.key, i]));
      for (const r of ranking) {
        const it = left.get(r.key);
        if (it) {
          ctx.note?.(r.g);
          return it;
        }
      }
      return randomOf(ctx.remaining, ctx.rng);
    },
  };
}

/**
 * Decision coverage by meaning (docs/RESEARCH.md §1.3): the question most similar in meaning to the reference
 * decisions (the mean of its three closest R questions by embedding cosine), minus `mmr` times its similarity to the
 * closest question already asked. No population and no model call per step: it ports to generated questions, with a
 * mimic's probes as the reference.
 */
export function semRefPolicy(knobs: PolicyKnobs): Policy {
  return {
    name: 'sem-ref',
    usesPopulation: false,
    next: async (ctx) => {
      const vec = (it: TwinItem) => ctx.vectors?.get(textOf(it));
      const refs = ctx.person.reference.map(vec).filter((v): v is number[] => !!v);
      const asked = ctx.asked.map(vec).filter((v): v is number[] => !!v);
      if (!refs.length) throw new Error('sem-ref needs embeddings of the reference questions');
      let best: TwinItem | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const it of ctx.remaining) {
        const v = vec(it);
        if (!v) continue;
        const sims = refs.map((r) => cosine(v, r)).sort((a, b) => b - a);
        const rel = sims.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, sims.length);
        const red = asked.length ? Math.max(...asked.map((a) => cosine(v, a))) : 0;
        const score = rel - knobs.mmr * red;
        if (score > bestScore + 1e-12) {
          bestScore = score;
          best = it;
        }
      }
      if (best) ctx.note?.(bestScore);
      return best ?? randomOf(ctx.remaining, ctx.rng);
    },
  };
}

/** Policies that embed questions (`embedTexts`) before they run. */
export const needsEmbeddings = (s: PolicySpec) => s.base === 'sem-ref';

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
        .filter((i) => ctx.posterior!.has(i.key))
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
  'pop-entropy',
  'pop-transfer',
  'sem-ref',
  'jev-eig',
  'hybrid',
  'jev-lift',
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
  /** Items asked before the base policy starts, from `opening`. */
  open: number;
  /**
   * `static`: the static questionnaire (`open10-…`); `anchors`: production's anchors as Twin asks them (`anchors-…`);
   * `custom`: the run's `--opening` sequence, all of it unless a number cuts it (`custom-…`, `custom6-…`).
   */
  opening: 'static' | 'anchors' | 'custom';
  knobs: Partial<PolicyKnobs>;
}

/**
 * Production's opening (`anchors.v1`, `packages/core/src/ontology/anchors.ts`) as Twin asks it: for each anchor the
 * Twin question closest in content. The five Big Five markers have BFI-44 counterparts (outgoing; considerate; thorough;
 * relaxed; active imagination), the risk gamble a row of the lottery price list, the intertemporal choice a row of the
 * now-or-later list, and the trust game the receiver's trust-game question. The work and Saturday scenes have none.
 * Shown in a per-person random order, as production does.
 */
export const TWIN_ANCHORS = [
  'twin2k/w13/QID25/36',
  'twin2k/w13/QID25/32',
  'twin2k/w13/QID25/3',
  'twin2k/w13/QID25/9',
  'twin2k/w13/QID25/20',
  'twin2k/w13/QID250/7',
  'twin2k/w13/QID246/4',
  'twin2k/w13/QID122',
] as const;

const KNOB_KEYS: Record<string, keyof PolicyKnobs> = {
  ent: 'entropyShortlist',
  short: 'lookaheadShortlist',
  refsize: 'referenceSize',
  tsel: 'tSel',
  floor: 'answerFloor',
  beta: 'beta',
  mmr: 'mmr',
  ref: 'reference',
  cls: 'classes',
  lshort: 'liftShortlist',
  lpeople: 'liftPeople',
};

export function parsePolicySpec(spec: string): PolicySpec {
  const m = /^(?:(open|anchors|custom)(\d+)?-)?([a-z-]+)(?:\[([^\]]*)\])?$/.exec(spec.trim());
  if (!m || !(POLICY_NAMES as readonly string[]).includes(m[3]!) || (m[1] === 'open' && !m[2]))
    throw new Error(
      `unknown policy ${spec} (known: ${POLICY_NAMES.join(', ')}; e.g. open10-jev-eig[ref=pool,tsel=1])`,
    );
  const knobs: Partial<PolicyKnobs> = {};
  for (const kv of (m[4] ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=').map((x) => x.trim());
    const key = KNOB_KEYS[k ?? ''];
    if (!key || v === undefined || v === '')
      throw new Error(`${spec}: unknown knob ${kv} (${Object.keys(KNOB_KEYS).join(', ')})`);
    if (key === 'reference') {
      if (v !== 'R' && v !== 'pool' && v !== 'id') throw new Error(`${spec}: ref is R, pool or id`);
      knobs.reference = v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${spec}: ${k} must be a number`);
      knobs[key] = n;
    }
  }
  const opening = m[1] === 'anchors' ? 'anchors' : m[1] === 'custom' ? 'custom' : 'static';
  const whole = opening === 'anchors' ? TWIN_ANCHORS.length : Number.MAX_SAFE_INTEGER;
  const open = m[1] ? Number(m[2] ?? whole) : 0;
  return { spec: spec.trim(), base: m[3] as PolicyName, open, opening, knobs };
}

/** Policies that ask Jev to select (none can run with `--no-jev`). */
export const needsJev = (s: PolicySpec) =>
  s.base === 'jev-entropy' || s.base === 'jev-eig' || s.base === 'hybrid' || s.base === 'jev-lift';

/** Policies that need the train population (to select, or for the static opening block). */
export const needsPopulation = (s: PolicySpec) =>
  s.base === 'pop-eig' ||
  s.base === 'pop-static' ||
  s.base === 'pop-entropy' ||
  s.base === 'pop-transfer' ||
  s.base === 'hybrid' ||
  s.base === 'jev-lift' ||
  (s.open > 0 && s.opening === 'static');

/**
 * The first `n` items of `sequence` (or of `sequence(pid)`, the person's own order) that the person's pool holds, then
 * `inner`; a sequence that runs out first hands over early.
 */
export function openedPolicy(
  name: string,
  n: number,
  sequence: readonly string[] | ((pid: string) => readonly string[]),
  inner: Policy,
): Policy {
  return {
    name,
    usesPopulation: inner.usesPopulation,
    ...(inner.beta !== undefined ? { beta: inner.beta } : {}),
    next: (ctx) => {
      if (ctx.asked.length < n) {
        const seq = typeof sequence === 'function' ? sequence(ctx.person.pid) : sequence;
        const left = new Map(ctx.remaining.map((i) => [i.key, i]));
        const opened = new Set(ctx.asked.map((i) => i.key));
        // Only while every question so far came from the opening: once one is missing, the opening is over.
        if (ctx.asked.every((i) => seq.includes(i.key)))
          for (const key of seq) {
            const it = left.get(key);
            if (it && !opened.has(key)) return Promise.resolve(it);
          }
      }
      return inner.next(ctx);
    },
  };
}

/** `--opening` tokens as item keys: `QID268` → `twin2k/w13/QID268`, `QID234/3` → `twin2k/w13/QID234/3`. */
export const openingKeys = (spec: string) =>
  spec
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('twin2k/') ? t : `twin2k/w13/${t}`));

/** Production's anchors in a per-person order (seeded like `anchors:{mimicId}` at intake). */
export const anchorOrder = (seed: string) => (pid: string) =>
  shuffle([...TWIN_ANCHORS], seededRng(`${seed}:anchors:${pid}`));
