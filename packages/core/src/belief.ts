import { normalizedEntropy } from './distribution';
import type { Domain, Facet, QType, TraitEstimate } from './types';

/**
 * The belief state (docs/SELECTION.md §3): what the mimic knows, does not know, is conflicted about and is bad at,
 * for one person. A pure, deterministic function of that person's own data; every quantity is in [0, 1]. It steers
 * selection (`VoiSelector`) and generation (`pool.refill` targets). It never enters a prompt or a state.
 */

export interface BeliefAnswer {
  seq: number;
  kind: 'anchor' | 'adaptive';
  type: QType;
  domain: Domain;
  facetIds: string[];
  answer: string;
  latencyMs: number;
  /** The sealed primary's item accuracy on this question, when it has been scored. */
  itemAcc?: number | null;
}

export interface BeliefRepeat {
  facetIds: string[];
  /** Agreement between the two answers in [0, 1] (PLAN §9.10). */
  agreement: number;
}

export interface BeliefInsight {
  facetIds: string[];
  status: 'active' | 'superseded' | 'user_rejected';
}

export interface BeliefInput {
  facets: Facet[];
  /** Answered anchor and adaptive questions, oldest first. */
  answers: BeliefAnswer[];
  /** Served but not yet answered questions count toward coverage and exposure, as `facetCounts` does. */
  served?: Array<{ type: QType; domain: Domain; facetIds: string[] }>;
  /** Pooled candidates count toward coverage only, so a refill doesn't pile onto facets the pool already has. */
  pooled?: Array<{ facetIds: string[] }>;
  traits: TraitEstimate[];
  insights: BeliefInsight[];
  repeats: BeliefRepeat[];
  domainMix: Record<Domain, number>;
}

export type TargetReason = 'unexplored' | 'uncertain' | 'conflicted' | 'weak';

export interface FacetBelief {
  id: string;
  group: string;
  mean: number | null;
  certainty: number | null;
  /** The facet's current reading, e.g. "Leans cautious", from the trait labels. */
  label: string | null;
  uncertainty: number;
  conflict: number;
  weakness: number;
  coverage: number;
  /** Share of the person's adaptive questions that touch this facet. */
  exposure: number;
  /** Answered questions touching the facet. */
  n: number;
  need: number;
  reason: TargetReason;
}

export interface DomainBelief {
  domain: Domain;
  share: number;
  target: number;
  /** Relative shortfall of the domain's share against its target, in [0, 1]. */
  shortfall: number;
  weakness: number;
  n: number;
}

export interface BeliefState {
  facets: Record<string, FacetBelief>;
  domains: Record<Domain, DomainBelief>;
  person: {
    nAnswered: number;
    nAdaptive: number;
    /** Overall recent prediction error (1 − item accuracy) of the sealed primary. */
    error: number;
    medianLatencyMs: number | null;
    speedingRate: number;
    straightlining: boolean;
  };
  /** Types and domains of the last few served questions, oldest first. */
  recent: { types: QType[]; domains: Domain[] };
}

export const NEED_WEIGHTS = { uncertainty: 0.35, conflict: 0.25, weakness: 0.25, gap: 0.15 } as const;
/** Facets reach full coverage after this many questions touch them (same rule as `facetCoverage`). */
export const BELIEF_COVERAGE_TARGET = 3;
/** Weakness looks at the last this many scored questions touching a facet or domain. */
export const WEAKNESS_WINDOW = 12;
/** Prior weight (in questions) pulling a facet's error toward the person's overall error. */
export const WEAKNESS_PRIOR = 2;
/** An answer slower than this multiple of the person's median latency is "torn" (near indifference). */
export const TORN_RATIO = 2;
/** An answer faster than this multiple of the median, and under SPEEDING_MAX_MS, is speeding. */
export const SPEEDING_RATIO = 0.3;
export const SPEEDING_MAX_MS = 2000;
/** Speeding answers count this much in every belief quantity. */
export const SPEEDING_RELIABILITY = 0.5;
/** Fewer answers than this and latency says nothing yet. */
export const LATENCY_MIN_N = 3;
export const RECENT_N = 3;
const DOMAINS: Domain[] = ['core', 'casual', 'professional'];

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export type Pace = 'quick' | 'even' | 'slow';

/** Pace of one answer against the person's own median latency (Konovalov & Krajbich 2019). */
export function paceOf(latencyMs: number, medianMs: number | null): Pace {
  if (medianMs === null || medianMs <= 0) return 'even';
  if (latencyMs < medianMs / TORN_RATIO) return 'quick';
  if (latencyMs > medianMs * TORN_RATIO) return 'slow';
  return 'even';
}

export function isSpeeding(latencyMs: number, medianMs: number | null): boolean {
  if (medianMs === null || medianMs <= 0) return false;
  return latencyMs < medianMs * SPEEDING_RATIO && latencyMs < SPEEDING_MAX_MS;
}

/** Longest run of identical answers at the end of the last six scale answers is the whole window. */
export function isStraightlining(answers: Array<{ type: QType; answer: string }>): boolean {
  const scales = answers.filter((a) => a.type === 'score').slice(-6);
  if (scales.length < 5) return false;
  return scales.every((a) => a.answer === scales[0]!.answer);
}

/** Reliability-weighted mean error shrunk toward `prior` with weight WEAKNESS_PRIOR. */
function shrunkError(items: Array<{ err: number; r: number }>, prior: number): number {
  let num = WEAKNESS_PRIOR * prior;
  let den = WEAKNESS_PRIOR;
  for (const it of items) {
    num += it.err * it.r;
    den += it.r;
  }
  return clamp01(num / den);
}

function latestByMethod(
  traits: TraitEstimate[],
): Map<string, { jev?: TraitEstimate; psych?: TraitEstimate }> {
  const by = new Map<string, { jev?: TraitEstimate; psych?: TraitEstimate }>();
  for (const t of traits) {
    const cur = by.get(t.facetId) ?? {};
    const slot = t.method === 'jev' ? 'jev' : 'psych';
    if (!cur[slot] || t.seqUpTo > cur[slot].seqUpTo) cur[slot] = t;
    by.set(t.facetId, cur);
  }
  return by;
}

export function buildBelief(input: BeliefInput): BeliefState {
  const answers = [...input.answers].sort((a, b) => a.seq - b.seq);
  const latencies = answers.map((a) => a.latencyMs).filter((x) => x > 0);
  const median = latencies.length >= LATENCY_MIN_N ? medianOf(latencies) : null;
  const reliability = (a: BeliefAnswer) => (isSpeeding(a.latencyMs, median) ? SPEEDING_RELIABILITY : 1);
  const torn = (a: BeliefAnswer) => paceOf(a.latencyMs, median) === 'slow';

  const scored = answers.filter((a) => typeof a.itemAcc === 'number');
  const overallError = scored.length
    ? clamp01(
        scored.reduce((s, a) => s + (1 - a.itemAcc!) * reliability(a), 0) /
          scored.reduce((s, a) => s + reliability(a), 0),
      )
    : 0.5;

  const nAdaptive = answers.filter((a) => a.kind === 'adaptive').length;
  const served = input.served ?? [];
  const pooled = input.pooled ?? [];
  const byMethod = latestByMethod(input.traits);

  const facets: Record<string, FacetBelief> = {};
  for (const f of input.facets) {
    const touching = answers.filter((a) => a.facetIds.includes(f.id));
    const n =
      touching.length +
      served.filter((s) => s.facetIds.includes(f.id)).length +
      pooled.filter((p) => p.facetIds.includes(f.id)).length;
    const t = byMethod.get(f.id);
    const read = t?.jev ?? t?.psych ?? null;
    const uncertainty = t?.jev
      ? clamp01(0.5 * normalizedEntropy(t.jev.dist) + 0.5 * (1 - t.jev.confidence))
      : 1;

    const methodGap = t?.jev && t?.psych ? clamp01(1.5 * Math.abs(t.jev.mean - t.psych.mean)) : 0;
    const citing = input.insights.filter((i) => i.facetIds.includes(f.id));
    const supersededShare = citing.length
      ? citing.filter((i) => i.status === 'superseded').length / citing.length
      : 0;
    const reps = input.repeats.filter((r) => r.facetIds.includes(f.id));
    const repeatDisagreement = reps.length
      ? reps.reduce((s, r) => s + (1 - clamp01(r.agreement)), 0) / reps.length
      : 0;
    const tornShare = touching.length ? touching.filter(torn).length / touching.length : 0;
    const conflict = clamp01(Math.max(methodGap, supersededShare, repeatDisagreement) + 0.5 * tornShare);

    const recentScored = touching.filter((a) => typeof a.itemAcc === 'number').slice(-WEAKNESS_WINDOW);
    const weakness = shrunkError(
      recentScored.map((a) => ({ err: 1 - a.itemAcc!, r: reliability(a) })),
      overallError,
    );

    const coverage = Math.min(1, n / BELIEF_COVERAGE_TARGET);
    const adaptiveTouching = touching.filter((a) => a.kind === 'adaptive').length;
    const exposure = nAdaptive ? adaptiveTouching / nAdaptive : 0;
    const need = clamp01(
      NEED_WEIGHTS.uncertainty * uncertainty +
        NEED_WEIGHTS.conflict * conflict +
        NEED_WEIGHTS.weakness * weakness +
        NEED_WEIGHTS.gap * (1 - coverage),
    );
    let reason: TargetReason = 'uncertain';
    if (coverage === 0) reason = 'unexplored';
    else if (conflict >= uncertainty && conflict >= weakness) reason = 'conflicted';
    else if (weakness > uncertainty) reason = 'weak';

    facets[f.id] = {
      id: f.id,
      group: f.group,
      mean: read ? read.mean : null,
      certainty: read ? read.confidence : null,
      label: read ? (f.labels[Math.round(clamp01(read.mean) * 4)] ?? null) : null,
      uncertainty,
      conflict,
      weakness,
      coverage,
      exposure,
      n: touching.length,
      need,
      reason,
    };
  }

  const mixTotal = DOMAINS.reduce((s, d) => s + Math.max(0, input.domainMix[d] ?? 0), 0) || 1;
  const adaptiveServed = served.length;
  const domains = {} as Record<Domain, DomainBelief>;
  for (const d of DOMAINS) {
    const inDomain = answers.filter((a) => a.domain === d);
    const nAdaptiveD =
      inDomain.filter((a) => a.kind === 'adaptive').length + served.filter((s) => s.domain === d).length;
    const denom = nAdaptive + adaptiveServed;
    const share = denom ? nAdaptiveD / denom : 0;
    const target = Math.max(0, input.domainMix[d] ?? 0) / mixTotal;
    const shortfall = target > 0 ? clamp01((target - share) / target) : 0;
    const recentScored = inDomain.filter((a) => typeof a.itemAcc === 'number').slice(-WEAKNESS_WINDOW);
    domains[d] = {
      domain: d,
      share,
      target,
      shortfall,
      weakness: shrunkError(
        recentScored.map((a) => ({ err: 1 - a.itemAcc!, r: reliability(a) })),
        overallError,
      ),
      n: inDomain.length,
    };
  }

  const speeding = answers.filter((a) => isSpeeding(a.latencyMs, median)).length;
  const recentServed = [...answers.map((a) => ({ type: a.type, domain: a.domain })), ...served].slice(
    -RECENT_N,
  );
  return {
    facets,
    domains,
    person: {
      nAnswered: answers.length,
      nAdaptive,
      error: overallError,
      medianLatencyMs: median,
      speedingRate: answers.length ? speeding / answers.length : 0,
      straightlining: isStraightlining(answers),
    },
    recent: { types: recentServed.map((r) => r.type), domains: recentServed.map((r) => r.domain) },
  };
}

export interface TargetFacet {
  id: string;
  name: string;
  low: string;
  high: string;
  reason: TargetReason;
  /** Current reading and its certainty, when the facet has been read. */
  label: string | null;
  certainty: number | null;
  need: number;
}

/**
 * The generator's targets: the `n` facets with the highest need, each with why it is targeted and the person's
 * current reading on it (docs/SELECTION.md §5). Facets over `exposureCap` are skipped.
 */
export function targetFacets(
  belief: BeliefState,
  facets: Facet[],
  n: number,
  exposureCap = 1,
): TargetFacet[] {
  return facets
    .map((f) => ({ f, b: belief.facets[f.id] }))
    .filter((x): x is { f: Facet; b: FacetBelief } => !!x.b && x.b.exposure <= exposureCap)
    .sort((a, b) => b.b.need - a.b.need || a.f.id.localeCompare(b.f.id))
    .slice(0, n)
    .map(({ f, b }) => ({
      id: f.id,
      name: f.name,
      low: f.low,
      high: f.high,
      reason: b.reason,
      label: b.label,
      certainty: b.certainty === null ? null : Math.round(b.certainty * 100) / 100,
      need: Math.round(b.need * 1000) / 1000,
    }));
}

/** Domain quota tilted toward the domains the mimic is weakest in: mix_d · (½ + weakness_d), renormalised. */
export function domainQuota(
  belief: BeliefState,
  mix: Record<Domain, number>,
  n: number,
): Record<Domain, number> {
  const w = DOMAINS.map((d) => Math.max(0, mix[d] ?? 0) * (0.5 + belief.domains[d].weakness));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const quota = { core: 0, casual: 0, professional: 0 } as Record<Domain, number>;
  let assigned = 0;
  DOMAINS.forEach((d, i) => {
    if (i === DOMAINS.length - 1) quota[d] = Math.max(0, n - assigned);
    else {
      quota[d] = Math.round((n * w[i]!) / total);
      assigned += quota[d];
    }
  });
  return quota;
}
