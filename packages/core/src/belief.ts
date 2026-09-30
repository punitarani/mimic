import { normalizedEntropy } from './distribution';
import { quantile } from './metrics';
import {
  CATEGORIES,
  type Category,
  type Domain,
  type Facet,
  type QType,
  type SensitiveArea,
  type TraitEstimate,
} from './types';

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

/** `sweep`: a consented sensitive facet not yet asked about, targeted late in the session (ADR-0044). */
export type TargetReason = 'unexplored' | 'uncertain' | 'conflicted' | 'weak' | 'sweep';

export interface FacetBelief {
  id: string;
  group: string;
  category: Category;
  /** The sensitive area of an opt-in facet, else null (ADR-0040). */
  sensitive: SensitiveArea | null;
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

/**
 * A category's share of the person's anchor and adaptive questions (answered or waiting), against an even split over
 * the categories in scope (ADR-0044). A question touching two categories counts half to each.
 */
export interface CategoryBelief {
  category: Category;
  share: number;
  target: number;
  /** Relative shortfall against the target, in [0, 1]. */
  shortfall: number;
  n: number;
}

/** How far a facet group is from being touched at all: 1 untouched, ½ after one question, 0 after GROUP_TARGET. */
export interface GroupBelief {
  group: string;
  category: Category;
  n: number;
  gap: number;
}

export interface BeliefState {
  facets: Record<string, FacetBelief>;
  domains: Record<Domain, DomainBelief>;
  /** Only categories with a facet in scope (ADR-0044): nothing pulls toward one the person turned off. */
  categories: Partial<Record<Category, CategoryBelief>>;
  groups: Record<string, GroupBelief>;
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
/** Facets reach full coverage after this many answered questions touch them (`facetCoverage` uses it too). */
export const COVERAGE_TARGET = 3;
/** Exposure control only starts once this many adaptive questions have been answered. */
export const EXPOSURE_MIN_ADAPTIVE = 4;
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
/** A facet group counts as covered after this many questions touch it (ADR-0044). */
export const GROUP_TARGET = 2;
const DOMAINS: Domain[] = ['core', 'casual', 'professional'];

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function medianOf(xs: number[]): number | null {
  return xs.length ? quantile(xs, 0.5) : null;
}

export type Pace = 'quick' | 'even' | 'slow';

/**
 * Pace of one answer against the person's own median latency (Konovalov & Krajbich 2019). A latency of 0 means no
 * timing was recorded, not an instant answer: it is 'even' here and never speeding below.
 */
export function paceOf(latencyMs: number, medianMs: number | null): Pace {
  if (medianMs === null || medianMs <= 0 || latencyMs <= 0) return 'even';
  if (latencyMs < medianMs / TORN_RATIO) return 'quick';
  if (latencyMs > medianMs * TORN_RATIO) return 'slow';
  return 'even';
}

export function isSpeeding(latencyMs: number, medianMs: number | null): boolean {
  if (medianMs === null || medianMs <= 0 || latencyMs <= 0) return false;
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

    const coverage = Math.min(1, n / COVERAGE_TARGET);
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
      category: f.category,
      sensitive: f.sensitive ?? null,
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

  // Categories and groups (ADR-0044) over answered and waiting anchor and adaptive questions, in scope only.
  const facetById = new Map(input.facets.map((f) => [f.id, f]));
  const asked = [...answers.map((a) => a.facetIds), ...served.map((q) => q.facetIds)];
  const categories = categoryShares(input.facets, asked);
  const groupCount = new Map<string, number>();
  for (const ids of asked) {
    const fs = ids.map((id) => facetById.get(id)).filter((f): f is Facet => !!f);
    for (const g of new Set(fs.map((f) => f.group))) groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  }
  const groups: Record<string, GroupBelief> = {};
  for (const f of input.facets) {
    if (groups[f.group]) continue;
    const n = groupCount.get(f.group) ?? 0;
    groups[f.group] = { group: f.group, category: f.category, n, gap: clamp01(1 - n / GROUP_TARGET) };
  }

  const speeding = answers.filter((a) => isSpeeding(a.latencyMs, median)).length;
  const recentServed = [...answers.map((a) => ({ type: a.type, domain: a.domain })), ...served].slice(
    -RECENT_N,
  );
  return {
    facets,
    domains,
    categories,
    groups,
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

/**
 * Exposure control (docs/SELECTION.md §4): true when the facet already takes more than `cap` of the person's
 * adaptive questions, once EXPOSURE_MIN_ADAPTIVE of them are answered. Shared by the selector and the generator.
 */
export function overExposed(belief: BeliefState, facetId: string, cap: number): boolean {
  if (belief.person.nAdaptive < EXPOSURE_MIN_ADAPTIVE) return false;
  return (belief.facets[facetId]?.exposure ?? 0) > cap;
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
    .filter((x): x is { f: Facet; b: FacetBelief } => !!x.b && !overExposed(belief, x.f.id, exposureCap))
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

/** Splits `n` questions across domains in proportion to `weights`; the rounding residual goes to the last domain. */
export function splitQuota(weights: Record<Domain, number>, n: number): Record<Domain, number> {
  const w = DOMAINS.map((d) => Math.max(0, weights[d] ?? 0));
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

/** Domain quota tilted toward the domains the mimic is weakest in: mix_d · (½ + weakness_d), renormalised. */
export function domainQuota(
  belief: BeliefState,
  mix: Record<Domain, number>,
  n: number,
): Record<Domain, number> {
  const weights = { core: 0, casual: 0, professional: 0 } as Record<Domain, number>;
  for (const d of DOMAINS) weights[d] = Math.max(0, mix[d] ?? 0) * (0.5 + belief.domains[d].weakness);
  return splitQuota(weights, n);
}

/**
 * Each category's share of the questions asked (their facet lists), against an even split over the categories in
 * `facets` (ADR-0044). A question touching two categories counts half to each; facets outside `facets` are ignored.
 */
export function categoryShares(
  facets: Facet[],
  asked: string[][],
): Partial<Record<Category, CategoryBelief>> {
  const byId = new Map(facets.map((f) => [f.id, f]));
  const catIn = CATEGORIES.filter((c) => facets.some((f) => f.category === c));
  const count = new Map<Category, number>();
  let total = 0;
  for (const ids of asked) {
    const cats = [...new Set(ids.map((id) => byId.get(id)?.category).filter((c): c is Category => !!c))];
    if (cats.length) total += 1;
    for (const c of cats) count.set(c, (count.get(c) ?? 0) + 1 / cats.length);
  }
  const out: Partial<Record<Category, CategoryBelief>> = {};
  for (const c of catIn) {
    const n = count.get(c) ?? 0;
    const share = total ? n / total : 0;
    const target = 1 / catIn.length;
    out[c] = { category: c, share, target, shortfall: clamp01((target - share) / target), n };
  }
  return out;
}

/**
 * A category this far below its even share (a shortfall of 0.4 is a 15% share with four categories, the rubric's
 * floor) with nothing waiting in the pool gets reserve items (ADR-0044).
 */
export const BEHIND_SHORTFALL = 0.4;

/** When sensitive questions may be asked and when the session sweeps the ones not yet asked (ADR-0044). */
export interface TrustRamp {
  /** No question touching a sensitive facet is served before this many anchor and adaptive answers. */
  minAnswered: number;
  /** From this many answers, consented sensitive facets not yet asked about are targeted and preferred. */
  sweepFrom: number;
  /** Score bonus for a candidate touching a consented sensitive facet not yet asked about. */
  sweepBonus: number;
}

/** True when a question touches a sensitive facet of the belief's (scoped) facet list. */
export function touchesSensitive(belief: BeliefState, q: { facetIds: string[] }): boolean {
  return q.facetIds.some((f) => !!belief.facets[f]?.sensitive);
}

/**
 * The trust ramp (ADR-0044): may a question touching a sensitive facet be served yet? `lookahead` counts questions
 * certain to be served first (the anchors still waiting), for a generator filling the pool ahead of time.
 */
export function rampOpen(belief: BeliefState, ramp: TrustRamp | undefined, lookahead = 0): boolean {
  return !ramp || belief.person.nAnswered + lookahead >= ramp.minAnswered;
}

/** True when `q` touches a consented sensitive facet no answered question has touched, and the sweep has begun. */
export function sweeps(belief: BeliefState, ramp: TrustRamp | undefined, q: { facetIds: string[] }): boolean {
  if (!ramp || belief.person.nAnswered < ramp.sweepFrom) return false;
  return q.facetIds.some((f) => {
    const b = belief.facets[f];
    return !!b?.sensitive && b.n === 0;
  });
}

/**
 * Splits `n` questions over the categories in scope, weighted ¼ + shortfall so every category keeps a share and the
 * ones behind their even split get more (ADR-0044). Largest remainder rounding; sums to `n`.
 */
export function categoryQuota(belief: BeliefState, n: number): Partial<Record<Category, number>> {
  const cats = CATEGORIES.filter((c) => belief.categories[c]);
  if (!cats.length) return {};
  const w = cats.map((c) => 0.25 + belief.categories[c]!.shortfall);
  const total = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (n * x) / total);
  const out = raw.map(Math.floor);
  const order = raw
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.i);
  for (let k = 0, left = n - out.reduce((a, b) => a + b, 0); left > 0; k++, left--)
    out[order[k % cats.length]!]! += 1;
  return Object.fromEntries(cats.map((c, i) => [c, out[i]!]));
}

/**
 * The generator's targets under category balance (ADR-0044), in three passes:
 *
 * 1. Groups: one facet from each facet group nothing has touched yet (answered, waiting or pooled), so every group in
 *    scope is reached early (rubric R2). Once the sweep has begun, a group's consented sensitive facet not yet asked
 *    about is preferred, which serves both passes.
 * 2. Sweep: once `ramp.sweepFrom` is reached, consented sensitive facets nothing has touched yet, one area at a time
 *    with the least asked areas first (rubric R4). Pooled facets count as touched, so the sweep ends once each has a
 *    question waiting; the selector decides when to ask it.
 * 3. Categories: the rest follow `categoryQuota`, within each category its facets with the highest need. The first two
 *    passes together leave a quarter of the targets, at least one, to this one.
 *
 * Sensitive facets are never targeted before the ramp opens, and facets over `exposureCap` are skipped, as in
 * `targetFacets`. Both ramp checks count `lookahead` questions served before this batch (the anchors still waiting).
 */
export function categoryTargets(
  belief: BeliefState,
  facets: Facet[],
  n: number,
  opts: { exposureCap?: number; ramp?: TrustRamp; lookahead?: number } = {},
): TargetFacet[] {
  const cap = opts.exposureCap ?? 1;
  const ramp = opts.ramp;
  const ahead = opts.lookahead ?? 0;
  const open = rampOpen(belief, ramp, ahead);
  const sweeping = !!ramp && open && belief.person.nAnswered + ahead >= ramp.sweepFrom;
  type Cand = { f: Facet; b: FacetBelief };
  const cand = facets
    .map((f) => ({ f, b: belief.facets[f.id] }))
    .filter((x): x is Cand => !!x.b && !overExposed(belief, x.f.id, cap))
    .filter((x) => open || !x.b.sensitive)
    .sort((a, b) => b.b.need - a.b.need || a.f.id.localeCompare(b.f.id));
  const chosen: Array<Cand & { reason: TargetReason }> = [];
  const taken = new Set<string>();
  const take = (x: Cand, reason: TargetReason) => {
    chosen.push({ ...x, reason });
    taken.add(x.f.id);
  };
  // Groups and the sweep together leave a quarter of the targets (at least one) to the category quota.
  const firstPasses = n - Math.max(1, Math.ceil(n / 4));

  // Sensitive facets not yet asked about, by area, the areas with the fewest facets touched first.
  const touchedIn = new Map<SensitiveArea, number>();
  for (const x of cand)
    if (x.b.sensitive && x.b.coverage > 0)
      touchedIn.set(x.b.sensitive, (touchedIn.get(x.b.sensitive) ?? 0) + 1);
  const areaRank = (x: Cand) =>
    x.b.sensitive ? (touchedIn.get(x.b.sensitive) ?? 0) : Number.POSITIVE_INFINITY;
  const unswept = (x: Cand) => sweeping && !!x.b.sensitive && x.b.coverage === 0;

  // 1) Groups nothing has touched.
  const groupTouched = new Set(
    facets.filter((f) => (belief.facets[f.id]?.coverage ?? 0) > 0).map((f) => f.group),
  );
  const groupOrder = [...new Set(cand.map((x) => x.f.group))].filter((g) => !groupTouched.has(g));
  for (const g of groupOrder) {
    if (chosen.length >= firstPasses) break;
    const inGroup = cand.filter((x) => x.f.group === g);
    const best =
      inGroup.filter(unswept).sort((a, b) => areaRank(a) - areaRank(b))[0] ??
      inGroup.find((x) => !x.b.sensitive || open);
    if (!best) continue;
    take(best, unswept(best) ? 'sweep' : best.b.reason);
    if (best.b.sensitive) touchedIn.set(best.b.sensitive, (touchedIn.get(best.b.sensitive) ?? 0) + 1);
  }

  // 2) The sweep.
  if (sweeping) {
    const byArea = new Map<SensitiveArea, Cand[]>();
    for (const x of cand)
      if (unswept(x) && !taken.has(x.f.id))
        byArea.set(x.b.sensitive!, [...(byArea.get(x.b.sensitive!) ?? []), x]);
    const lists = [...byArea.entries()]
      .sort(([a], [b]) => (touchedIn.get(a) ?? 0) - (touchedIn.get(b) ?? 0))
      .map(([, l]) => l);
    for (let i = 0; chosen.length < firstPasses && lists.some((l) => l.length); i++) {
      const next = lists[i % lists.length]!.shift();
      if (next) take(next, 'sweep');
    }
  }

  // 3) Categories.
  const quota = categoryQuota(belief, n - chosen.length);
  const cats = CATEGORIES.filter((c) => quota[c] !== undefined).sort(
    (a, b) => belief.categories[b]!.shortfall - belief.categories[a]!.shortfall,
  );
  for (const c of cats) {
    let k = quota[c] ?? 0;
    for (const x of cand) {
      if (k <= 0) break;
      if (x.f.category !== c || taken.has(x.f.id)) continue;
      take(x, x.b.reason);
      k--;
    }
  }
  // A category without enough eligible facets gives its slots to the highest need anywhere.
  for (const x of cand) {
    if (chosen.length >= n) break;
    if (!taken.has(x.f.id)) take(x, x.b.reason);
  }
  return chosen.slice(0, n).map(({ f, b, reason }) => ({
    id: f.id,
    name: f.name,
    low: f.low,
    high: f.high,
    reason,
    label: b.label,
    certainty: b.certainty === null ? null : Math.round(b.certainty * 100) / 100,
    need: Math.round(b.need * 1000) / 1000,
  }));
}
