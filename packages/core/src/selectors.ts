import {
  BEHIND_SHORTFALL,
  type BeliefState,
  COVERAGE_TARGET,
  deadlinePressed,
  EXPOSURE_MIN_ADAPTIVE,
  overExposed,
  rampOpen,
  sweeps,
  touchesSensitive,
  unsweptFacets,
  untouchedGroups,
} from './belief';
import type { PipelineConfig } from './config';
import { entropy, meanDist, normalizedEntropy, optionKeys, P_FLOOR } from './distribution';
import { canonicalJson, sha256Hex } from './hash';
import type { Category, Distribution, PersonState, PredictionResult, Predictor, Question } from './types';

export interface SelectContext {
  pool: Question[];
  /** Sealed state for the question about to be served. */
  state: PersonState;
  primary: Predictor;
  /** Facet coverage of a question in [0, 1]. */
  coverage: (q: Question) => number;
  /** Max similarity of a question to anything already asked, in [0, 1]. */
  redundancy: (q: Question) => number;
  rng: () => number;
  /** BALD persona hypotheses (PLAN §9.5). */
  hypotheses?: string[];
  /** Posterior weight of each hypothesis (docs/SELECTION.md §6); uniform when absent. */
  hypothesisWeights?: number[];
  /** Predictor for BALD's hypothesis calls (same model; logged under its own purpose). Defaults to `primary`. */
  explore?: Predictor;
  /** The person's belief state (`voi` only). */
  belief?: BeliefState;
  /** Cross-person informativeness of a candidate in [0, 1], or null when unknown (`voi` only). */
  population?: (q: Question) => number | null;
  /** Session target, for the fatigue term. */
  sessionTarget?: number;
  /** The seq the chosen question will be served at, for coverage deadlines (ADR-0044). */
  seq?: number;
  /** How often repeat probes take a slot (`cfg.repeats.every`), so deadlines leave room for them. */
  repeatsEvery?: number;
}

export interface Selection {
  question: Question;
  primary: PredictionResult;
  diagnostics: Record<string, number>;
  /** The chosen question's prediction under each hypothesis, with the state it was predicted from (`voi`). */
  hypothesisPreds?: Array<{ index: number; state: PersonState; result: PredictionResult }>;
}

export interface Selector {
  readonly type: PipelineConfig['selector']['type'];
  select(ctx: SelectContext): Promise<Selection>;
}

function pick<T>(xs: T[], rng: () => number): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

async function predictOne(ctx: SelectContext, q: Question): Promise<PredictionResult> {
  const [r] = await ctx.primary.predict(ctx.state, [q]);
  return r!;
}

export class RandomSelector implements Selector {
  readonly type = 'random' as const;
  async select(ctx: SelectContext): Promise<Selection> {
    const question = pick(ctx.pool, ctx.rng);
    return { question, primary: await predictOne(ctx, question), diagnostics: { poolSize: ctx.pool.length } };
  }
}

export class CoverageSelector implements Selector {
  readonly type = 'coverage' as const;
  async select(ctx: SelectContext): Promise<Selection> {
    const cov = ctx.pool.map((q) => ctx.coverage(q));
    const min = Math.min(...cov);
    const question = pick(
      ctx.pool.filter((_, i) => cov[i] === min),
      ctx.rng,
    );
    return {
      question,
      primary: await predictOne(ctx, question),
      diagnostics: { poolSize: ctx.pool.length, coverage: min },
    };
  }
}

/** score(q) = H(p_q)/log|options_q| + λ·(1 − coverage(q)) − μ·maxSim(q, asked) (PLAN §9.5). */
export class EntropySelector implements Selector {
  readonly type = 'entropy' as const;
  constructor(
    private readonly lambda: number,
    private readonly mu: number,
  ) {}

  async select(ctx: SelectContext): Promise<Selection> {
    const preds = await ctx.primary.predict(ctx.state, ctx.pool);
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestParts = { h: 0, cov: 0, sim: 0 };
    ctx.pool.forEach((q, i) => {
      const p = preds[i]!;
      if (!p.ok) return;
      const h = normalizedEntropy(p.dist);
      const cov = ctx.coverage(q);
      const sim = ctx.redundancy(q);
      const s = h + this.lambda * (1 - cov) - this.mu * sim;
      if (s > bestScore) {
        bestScore = s;
        best = i;
        bestParts = { h, cov, sim };
      }
    });
    if (best < 0) {
      // Every prediction failed: fall back to a random pick; the engine handles the failed primary.
      const i = Math.floor(ctx.rng() * ctx.pool.length);
      return {
        question: ctx.pool[i]!,
        primary: preds[i]!,
        diagnostics: { poolSize: ctx.pool.length, failed: 1 },
      };
    }
    return {
      question: ctx.pool[best]!,
      primary: preds[best]!,
      diagnostics: {
        poolSize: ctx.pool.length,
        score: bestScore,
        entropy: bestParts.h,
        coverage: bestParts.cov,
        redundancy: bestParts.sim,
      },
    };
  }
}

/** Adds one persona hypothesis to a state (BALD). The hash is recomputed so it never collides with the sealed state. */
export function withHypothesis(state: PersonState, hypothesis: string): PersonState {
  const { meta, ...body } = state;
  const next = { ...body, hypothesis };
  return {
    ...next,
    meta: { ...meta, stateHash: sha256Hex(canonicalJson(next)), builder: `${meta.builder}+hyp` },
  };
}

/**
 * BALD (PLAN §9.5): MI(q) = H(mean_k p_k(q)) − mean_k H(p_k(q)) + λ·(1 − coverage). K hypothesis calls plus one
 * sealed primary call, all in parallel.
 */
export class BaldSelector implements Selector {
  readonly type = 'bald' as const;
  constructor(
    private readonly k: number,
    private readonly lambda: number,
  ) {}

  async select(ctx: SelectContext): Promise<Selection> {
    const hyps = (ctx.hypotheses ?? []).slice(0, this.k);
    if (hyps.length < 2) {
      // Not enough hypotheses yet (cached per reflection): behave like entropy without redundancy.
      return new EntropySelector(this.lambda, 0).select(ctx);
    }
    const [primaryPreds, ...hypPreds] = await Promise.all([
      ctx.primary.predict(ctx.state, ctx.pool),
      ...hyps.map((h) => (ctx.explore ?? ctx.primary).predict(withHypothesis(ctx.state, h), ctx.pool)),
    ]);
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestMi = 0;
    ctx.pool.forEach((q, i) => {
      if (!primaryPreds![i]!.ok) return;
      const dists = hypPreds
        .map((ps) => ps[i]!)
        .filter((p) => p.ok)
        .map((p) => p.dist);
      if (dists.length < 2) return;
      const keys = optionKeys(q);
      const mi = entropy(meanDist(dists, keys)) - dists.reduce((a, d) => a + entropy(d), 0) / dists.length;
      const s = mi + this.lambda * (1 - ctx.coverage(q));
      if (s > bestScore) {
        bestScore = s;
        best = i;
        bestMi = mi;
      }
    });
    if (best < 0) return new EntropySelector(this.lambda, 0).select(ctx);
    return {
      question: ctx.pool[best]!,
      primary: primaryPreds![best]!,
      diagnostics: { poolSize: ctx.pool.length, score: bestScore, mi: bestMi, k: hyps.length },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Value of information (docs/SELECTION.md §4, ADR-0027)
// ---------------------------------------------------------------------------------------------------------------

export type VoiConfig = Extract<PipelineConfig['selector'], { type: 'voi' }>;

/** Prompts longer than this many words count as full burden. */
export const BURDEN_WORDS = 40;

/**
 * Posterior weights over K persona hypotheses from the likelihood each gave the answers observed since the set was
 * written: w_k ∝ Π_t p_k(a_t), uniform prior, likelihoods floored at P_FLOOR. Uniform with no observations.
 */
export function hypothesisPosterior(obs: Array<{ index: number; pAnswer: number }>, k: number): number[] {
  const logw = new Array<number>(k).fill(0);
  for (const o of obs) {
    if (o.index < 0 || o.index >= k) continue;
    logw[o.index]! += Math.log(Math.max(P_FLOOR, Math.min(1, o.pAnswer)));
  }
  const max = Math.max(...logw);
  const w = logw.map((x) => Math.exp(x - max));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}

/** Weighted BALD mutual information: H(Σ_k w_k p_k) − Σ_k w_k H(p_k), in nats. */
export function weightedMutualInformation(dists: Distribution[], weights: number[], keys: string[]): number {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const w = weights.map((x) => x / total);
  const mix: Distribution = Object.fromEntries(keys.map((k) => [k, 0]));
  let expected = 0;
  dists.forEach((d, i) => {
    for (const k of keys) mix[k]! += w[i]! * (d[k] ?? 0);
    expected += w[i]! * entropy(d);
  });
  return Math.max(0, entropy(mix) - expected);
}

/**
 * Burden of asking `q` now, in [0, 1]: prompt length weighted by session fatigue, plus streaks of the same type or
 * domain in the last served questions (Krosnick's satisficing: length, difficulty and monotony).
 */
export function burdenOf(
  q: Pick<Question, 'prompt' | 'type' | 'domain'>,
  belief: BeliefState | undefined,
  sessionTarget: number,
): number {
  const words = q.prompt.trim().split(/\s+/).length;
  const length = Math.min(1, words / BURDEN_WORDS);
  const n = belief?.person.nAnswered ?? 0;
  const fatigue = Math.min(1, n / Math.max(1, sessionTarget));
  const streak = (xs: string[], v: string) => {
    if (xs.length >= 3 && xs.slice(-3).every((x) => x === v)) return 1;
    if (xs.length >= 2 && xs.slice(-2).every((x) => x === v)) return 0.5;
    return 0;
  };
  const typeStreak = belief ? streak(belief.recent.types, q.type) : 0;
  const domainStreak = belief ? streak(belief.recent.domains, q.domain) : 0;
  return Math.min(1, 0.6 * length * (0.5 + 0.5 * fatigue) + 0.25 * typeStreak + 0.15 * domainStreak);
}

export interface VoiParts {
  info: number;
  gap: number;
  /** With `balance` (ADR-0044): the candidate's category shortfall and facet-group gap, both inside `gap`. */
  category?: number;
  group?: number;
  /** With `trustRamp`: 1 when the candidate sweeps a consented sensitive facet not yet asked about. */
  sweep?: number;
  conflict: number;
  weakness: number;
  population: number;
  redundancy: number;
  burden: number;
  score: number;
}

/**
 * score(q) = info + λ·gap + β·conflict + γ·weakness + π·(pop − ½) − μ·redundancy − ν·burden. `info` is on one scale
 * for the whole selection: when any candidate has ≥ 2 hypothesis predictions, it is the posterior-weighted
 * hypothesis MI (0 for a candidate whose exploration calls failed, never its entropy); otherwise it is the
 * normalised predictive entropy for every candidate.
 */
export class VoiSelector implements Selector {
  readonly type = 'voi' as const;
  constructor(private readonly cfg: VoiConfig) {}

  parts(
    ctx: SelectContext,
    q: Question,
    primary: PredictionResult,
    hypDists: Distribution[],
    weights: number[],
    hypRegime: boolean,
  ): VoiParts {
    const keys = optionKeys(q);
    const logN = Math.log(Math.max(2, keys.length));
    const info = hypRegime
      ? hypDists.length >= 2
        ? Math.min(1, weightedMutualInformation(hypDists, weights, keys) / logN)
        : 0
      : normalizedEntropy(primary.dist);
    const b = ctx.belief;
    const facets = q.facetIds.map((f) => b?.facets[f]).filter((x): x is NonNullable<typeof x> => !!x);
    const meanOf = (pick: (f: NonNullable<(typeof facets)[number]>) => number) =>
      facets.length ? facets.reduce((s, f) => s + pick(f), 0) / facets.length : 0;
    const facetGap = b ? meanOf((f) => 1 - f.coverage) : 1 - ctx.coverage(q);
    const domainGap = b ? b.domains[q.domain].shortfall : 0;
    let gap = b ? 0.5 * facetGap + 0.5 * domainGap : facetGap;
    const balance = b ? this.cfg.balance : undefined;
    let category: number | undefined;
    let group: number | undefined;
    if (b && balance) {
      // Category shortfall and facet-group gap take their share of the gap term (ADR-0044). Only categories and
      // groups in scope exist in the belief, so nothing pulls toward what the person turned off.
      const cats = [...new Set(facets.map((f) => f.category))];
      const groups = [...new Set(facets.map((f) => f.group))];
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
      category = avg(cats.map((c) => b.categories[c]?.shortfall ?? 0));
      group = avg(groups.map((g) => b.groups[g]?.gap ?? 0));
      gap =
        (1 - balance.category - balance.group) * gap + balance.category * category + balance.group * group;
    }
    const sweep = b && this.cfg.trustRamp ? (sweeps(b, this.cfg.trustRamp, q) ? 1 : 0) : undefined;
    const conflict = meanOf((f) => f.conflict);
    const weakness = b ? 0.5 * meanOf((f) => f.weakness) + 0.5 * b.domains[q.domain].weakness : 0;
    const pop = this.cfg.piPopulation > 0 ? (ctx.population?.(q) ?? null) : null;
    const population = pop === null ? 0 : pop - 0.5;
    const redundancy = ctx.redundancy(q);
    const burden = burdenOf(q, b, ctx.sessionTarget ?? 30);
    const score =
      info +
      this.cfg.lambdaCoverage * gap +
      this.cfg.betaConflict * conflict +
      this.cfg.gammaWeakness * weakness +
      this.cfg.piPopulation * population -
      this.cfg.muRedundancy * redundancy -
      this.cfg.nuBurden * burden +
      (sweep ? (this.cfg.trustRamp?.sweepBonus ?? 0) : 0);
    return {
      info,
      gap,
      ...(category !== undefined ? { category } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(sweep !== undefined ? { sweep } : {}),
      conflict,
      weakness,
      population,
      redundancy,
      burden,
      score,
    };
  }

  /**
   * Exposure control: candidates whose facets already dominate the adaptive questions, unless all do. With `balance`,
   * the same for candidates whose categories all exceed the cap, and while a category is below BEHIND_SHORTFALL of its
   * even share, only candidates in it if there are any. With `trustRamp`, sensitive candidates before the ramp opens,
   * with no exception (the engine never offers only those; ADR-0044). When a coverage deadline would otherwise be
   * missed (`deadlinePressed`), only candidates that cover an untouched group or an unswept sensitive facet.
   */
  eligible(ctx: SelectContext): boolean[] {
    const b = ctx.belief;
    const flags = ctx.pool.map(() => true);
    if (!b) return flags;
    // The ramp first: exposure, the cap and the floor choose among the candidates it allows, so none of them can
    // narrow the pool to held-back candidates only and leave nothing eligible.
    const ramp = this.cfg.trustRamp;
    const allowed = ctx.pool.map((q) => !ramp || rampOpen(b, ramp) || !touchesSensitive(b, q));
    const over = ctx.pool.map((q) => q.facetIds.some((f) => overExposed(b, f, this.cfg.exposureCap)));
    let ok = allowed;
    const fresh = ok.map((o, i) => o && !over[i]);
    if (fresh.some(Boolean)) ok = fresh;
    const cap = this.cfg.balance?.cap;
    if (cap !== undefined && b.person.nAdaptive >= EXPOSURE_MIN_ADAPTIVE) {
      const catsOf = (q: Question) => [
        ...new Set(q.facetIds.map((f) => b.facets[f]?.category).filter((c): c is Category => !!c)),
      ];
      const full = ctx.pool.map((q) => {
        const cats = catsOf(q);
        return cats.length > 0 && cats.every((c) => (b.categories[c]?.share ?? 0) > cap);
      });
      const kept = ok.map((o, i) => o && !full[i]);
      if (kept.some(Boolean)) ok = kept;
      // The floor: while a category is far behind its even share, a candidate in it goes first (the engine tops the
      // pool up from the reserve so one exists).
      const behind = new Set(
        Object.values(b.categories)
          .filter((c) => c.shortfall >= BEHIND_SHORTFALL)
          .map((c) => c.category),
      );
      if (behind.size) {
        const lifts = ok.map((o, i) => o && catsOf(ctx.pool[i]!).some((c) => behind.has(c)));
        if (lifts.some(Boolean)) ok = lifts;
      }
    }
    // Coverage deadlines take precedence over exposure, the cap and the floor, never over the ramp.
    const seq = ctx.seq ?? b.person.nAnswered + 1;
    const pressing: Array<(q: Question) => boolean> = [];
    const groupsBy = this.cfg.balance?.groupsBy;
    if (groupsBy !== undefined) {
      const open = untouchedGroups(b);
      if (deadlinePressed(open.size, seq, groupsBy, ctx.repeatsEvery))
        pressing.push((q) => q.facetIds.some((f) => open.has(b.facets[f]?.group ?? '')));
    }
    if (ramp && rampOpen(b, ramp)) {
      const open = unsweptFacets(b);
      if (deadlinePressed(open.size, seq, ramp.sweepBy, ctx.repeatsEvery))
        pressing.push((q) => q.facetIds.some((f) => open.has(f)));
    }
    if (pressing.length) {
      const due = ctx.pool.map((q, i) => allowed[i]! && pressing.some((meets) => meets(q)));
      if (due.some(Boolean)) {
        const both = due.map((d, i) => d && ok[i]!);
        return both.some(Boolean) ? both : due;
      }
    }
    return ok;
  }

  async select(ctx: SelectContext): Promise<Selection> {
    const hyps = (ctx.hypotheses ?? []).slice(0, this.cfg.k);
    const useHyps = this.cfg.k >= 2 && hyps.length >= 2;
    const hypStates = useHyps ? hyps.map((h) => withHypothesis(ctx.state, h)) : [];
    const [primaryPreds, ...hypPreds] = await Promise.all([
      ctx.primary.predict(ctx.state, ctx.pool),
      ...hypStates.map((s) => (ctx.explore ?? ctx.primary).predict(s, ctx.pool)),
    ]);
    const weights =
      (ctx.hypothesisWeights ?? []).length === hyps.length && hyps.length
        ? ctx.hypothesisWeights!
        : hyps.map(() => 1 / Math.max(1, hyps.length));
    const eligible = this.eligible(ctx);
    const okHypsFor = (i: number) =>
      hypPreds.map((ps, k) => ({ d: ps[i]!, w: weights[k]! })).filter((x) => x.d.ok);
    // One information scale per selection (see the class comment).
    const hypRegime = hypStates.length >= 2 && ctx.pool.some((_, i) => okHypsFor(i).length >= 2);
    let best = -1;
    let bestParts: VoiParts | null = null;
    ctx.pool.forEach((q, i) => {
      const p = primaryPreds[i]!;
      if (!p.ok || !eligible[i]) return;
      const okHyps = okHypsFor(i);
      const parts = this.parts(
        ctx,
        q,
        p,
        okHyps.map((x) => x.d.dist),
        okHyps.map((x) => x.w),
        hypRegime,
      );
      if (!bestParts || parts.score > bestParts.score) {
        best = i;
        bestParts = parts;
      }
    });
    if (best < 0 || !bestParts) {
      // Every prediction failed: a random pick, never one the trust ramp holds back while another is allowed.
      const b = ctx.belief;
      const ramp = this.cfg.trustRamp;
      const all = ctx.pool.map((_, i) => i);
      const allowed =
        b && ramp && !rampOpen(b, ramp) ? all.filter((i) => !touchesSensitive(b, ctx.pool[i]!)) : all;
      const from = allowed.length ? allowed : all;
      const i = from[Math.floor(ctx.rng() * from.length)]!;
      return {
        question: ctx.pool[i]!,
        primary: primaryPreds[i]!,
        diagnostics: { poolSize: ctx.pool.length, failed: 1 },
      };
    }
    const parts: VoiParts = bestParts;
    const chosen = ctx.pool[best]!;
    const selection: Selection = {
      question: chosen,
      primary: primaryPreds[best]!,
      diagnostics: {
        poolSize: ctx.pool.length,
        eligible: eligible.filter(Boolean).length,
        k: hypStates.length,
        score: parts.score,
        info: parts.info,
        gap: parts.gap,
        conflict: parts.conflict,
        weakness: parts.weakness,
        population: parts.population,
        redundancy: parts.redundancy,
        burden: parts.burden,
        ...(parts.category !== undefined ? { category: parts.category } : {}),
        ...(parts.group !== undefined ? { group: parts.group } : {}),
        ...(parts.sweep !== undefined ? { sweep: parts.sweep } : {}),
      },
    };
    if (hypStates.length)
      // Failed exploration calls carry no information and are not persisted (the call log records them).
      selection.hypothesisPreds = hypStates
        .map((state, k) => ({ index: k, state, result: hypPreds[k]![best]! }))
        .filter((h) => h.result.ok);
    return selection;
  }
}

export function makeSelector(cfg: PipelineConfig['selector']): Selector {
  switch (cfg.type) {
    case 'random':
      return new RandomSelector();
    case 'coverage':
      return new CoverageSelector();
    case 'entropy':
      return new EntropySelector(cfg.lambdaCoverage, cfg.muRedundancy);
    case 'bald':
      return new BaldSelector(cfg.k, cfg.lambdaCoverage);
    case 'voi':
      return new VoiSelector(cfg);
  }
}

/** Selectors that explore with persona hypotheses, so `hypotheses.refresh` must run for them. */
export function usesHypotheses(cfg: PipelineConfig['selector']): boolean {
  return cfg.type === 'bald' || (cfg.type === 'voi' && cfg.k >= 2);
}

export function facetCoverage(counts: Map<string, number>, facetId: string): number {
  return Math.min(1, (counts.get(facetId) ?? 0) / COVERAGE_TARGET);
}

export function questionCoverage(counts: Map<string, number>, q: Pick<Question, 'facetIds'>): number {
  if (!q.facetIds.length) return 1;
  return q.facetIds.reduce((a, f) => a + facetCoverage(counts, f), 0) / q.facetIds.length;
}
