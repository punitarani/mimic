import type { PipelineConfig } from './config';
import { entropy, meanDist, normalizedEntropy, optionKeys } from './distribution';
import { canonicalJson, sha256Hex } from './hash';
import type { PersonState, PredictionResult, Predictor, Question } from './types';

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
  /** Predictor for BALD's hypothesis calls (same model; logged under its own purpose). Defaults to `primary`. */
  explore?: Predictor;
}

export interface Selection {
  question: Question;
  primary: PredictionResult;
  diagnostics: Record<string, number>;
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
  }
}

/** Facets reach full coverage after this many answered questions touch them. */
export const COVERAGE_TARGET = 3;

export function facetCoverage(counts: Map<string, number>, facetId: string): number {
  return Math.min(1, (counts.get(facetId) ?? 0) / COVERAGE_TARGET);
}

export function questionCoverage(counts: Map<string, number>, q: Pick<Question, 'facetIds'>): number {
  if (!q.facetIds.length) return 1;
  return q.facetIds.reduce((a, f) => a + facetCoverage(counts, f), 0) / q.facetIds.length;
}
