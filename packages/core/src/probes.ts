import { z } from 'zod';
import { seededRng } from './hash';
import type { ItemTemplate } from './ontology/anchors';
import { getReserveSet } from './ontology/reserve';
import type { QuestionRecord } from './store';
import { isScoredKind, isSessionKind } from './types';

/**
 * E7's held-out probes (ADR-0062, docs/PROBE.md): items served at fixed points in a session, predicted from the sealed
 * state like any question and never chosen by the selector, so what the mimic has learned is measured apart from
 * what selection asks next. Each probe records how far it sits from what the person had answered when it was served.
 */
export const PROBE_TIERS = ['shared', 'repeat', 'near', 'mid', 'far'] as const;
export type ProbeTier = (typeof PROBE_TIERS)[number];

/** `provenance.generator` of a probe question. */
export const PROBE_GENERATOR = 'probe';

export const ProbeConfig = z.object({
  set: z.literal('probe.v1'),
  /** Item keys of the reserve bank asked of everyone, in schedule order; the selector never offers them. */
  shared: z.array(z.string()),
  /** Each slot opens once the person has answered this many other session questions, and serves its tiers in order. */
  slots: z.array(z.object({ after: z.number().int().nonnegative(), tiers: z.array(z.enum(PROBE_TIERS)) })),
});
export type ProbeConfig = z.infer<typeof ProbeConfig>;

export const ProbeMeta = z.object({
  set: z.string(),
  slot: z.number().int(),
  index: z.number().int(),
  /** What the schedule asked for, and where the served item actually sat (they differ when a tier had no item). */
  planned: z.enum(PROBE_TIERS),
  tier: z.enum(PROBE_TIERS),
  /** The most answers on any of the item's facets before it was served. */
  load: z.number().int(),
  /** `repeat` only: the answered question it asks again. */
  sourceId: z.string().optional(),
});
export type ProbeMeta = z.infer<typeof ProbeMeta>;

/** A repeat asked of a probe copies its record but is a repeat, not a probe. */
export const isProbe = (q: Pick<QuestionRecord, 'kind' | 'provenance'>) =>
  q.kind === 'adaptive' && q.provenance.generator === PROBE_GENERATOR;

export function probeMetaOf(q: Pick<QuestionRecord, 'kind' | 'provenance' | 'quality'>): ProbeMeta | null {
  if (!isProbe(q)) return null;
  const parsed = ProbeMeta.safeParse(q.quality?.probe);
  return parsed.success ? parsed.data : null;
}

/**
 * Where the person is in the session the probes are added to: answered session questions that are not probes
 * (anchors, adaptive questions and repeats). Slot 30 opens where a cfg.default.v8 session reaches its target.
 */
export function probeClock(questions: QuestionRecord[]): number {
  return questions.filter((q) => q.status === 'answered' && isSessionKind(q.kind) && !isProbe(q)).length;
}

/** The next probe the schedule owes, or null. A probe counts once served; one that was discarded is owed again. */
export function dueProbe(
  probes: ProbeConfig,
  questions: QuestionRecord[],
): { slot: number; index: number; planned: ProbeTier } | null {
  const clock = probeClock(questions);
  const taken = new Map<number, number>();
  for (const q of questions) {
    if (q.status !== 'served' && q.status !== 'answered') continue;
    const meta = probeMetaOf(q);
    if (meta) taken.set(meta.slot, (taken.get(meta.slot) ?? 0) + 1);
  }
  for (const slot of probes.slots) {
    if (slot.after > clock) return null;
    const n = taken.get(slot.after) ?? 0;
    if (n < slot.tiers.length) return { slot: slot.after, index: n, planned: slot.tiers[n]! };
  }
  return null;
}

/** Distance from what was answered: two or more answers on one of the item's facets is near, one is mid, none far. */
export function tierOfLoad(load: number): 'near' | 'mid' | 'far' {
  return load >= 2 ? 'near' : load === 1 ? 'mid' : 'far';
}

const FALLBACK: Record<ProbeTier, ProbeTier[]> = {
  shared: ['shared', 'far', 'mid', 'near'],
  repeat: ['repeat', 'near', 'mid', 'far'],
  near: ['near', 'mid', 'far'],
  mid: ['mid', 'near', 'far'],
  far: ['far', 'mid', 'near'],
};

export interface PickedProbe {
  item: ItemTemplate;
  tier: ProbeTier;
  load: number;
  sourceId?: string;
}

/**
 * The item for a due probe: the shared item due next, an early anchor asked again, or an unused bank item at the
 * planned distance. When the planned tier has nothing left, the nearest other tier is used and recorded as such.
 * `allow` is the caller's scope and sensitivity check, applied to repeats as well.
 */
export function pickProbe(args: {
  probes: ProbeConfig;
  bank: string;
  mimicId: string;
  questions: QuestionRecord[];
  due: { slot: number; index: number; planned: ProbeTier };
  allow: (item: ItemTemplate) => boolean;
}): PickedProbe | null {
  const { probes, questions, due } = args;
  const counts = new Map<string, number>();
  for (const q of questions)
    if (q.status === 'answered' && isScoredKind(q.kind))
      for (const f of q.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
  const loadOf = (item: { facetIds: string[] }) =>
    Math.max(0, ...item.facetIds.map((f) => counts.get(f) ?? 0));
  // A discarded record, or a probe that was never served (a lost race, an undo), does not use up its item.
  const live = questions.filter((q) => q.status !== 'discarded' && !(isProbe(q) && q.status === 'pooled'));
  const used = new Set(live.map((q) => q.itemKey).filter(Boolean));
  const shared = new Set(probes.shared);
  const bank = getReserveSet(args.bank);
  const rng = seededRng(`probe:${args.mimicId}:${due.slot}:${due.index}`);
  const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rng() * xs.length)];

  for (const tier of FALLBACK[due.planned]) {
    if (tier === 'shared') {
      // The k-th shared item goes with the k-th `shared` entry of the schedule, so everyone gets the same item there.
      const k = probes.slots
        .flatMap((s) => s.tiers.map((t, i) => ({ after: s.after, i, t })))
        .filter((x) => x.t === 'shared')
        .findIndex((x) => x.after === due.slot && x.i === due.index);
      const item = bank.find((r) => r.itemKey === probes.shared[k]);
      if (item && !used.has(item.itemKey) && args.allow(item)) return { item, tier, load: loadOf(item) };
      continue;
    }
    if (tier === 'repeat') {
      const repeated = new Set(live.map((q) => probeMetaOf(q)?.sourceId).filter(Boolean));
      const src = questions
        .filter((q) => q.kind === 'anchor' && q.status === 'answered' && !repeated.has(q.id))
        .sort((a, b) => a.seq! - b.seq!)[0];
      if (src) {
        const item: ItemTemplate = {
          itemKey: src.itemKey ?? `repeat:${src.id}`,
          type: src.type,
          domain: src.domain,
          prompt: src.prompt,
          options: src.options,
          facetIds: src.facetIds,
        };
        if (args.allow(item)) return { item, tier, load: loadOf(item), sourceId: src.id };
      }
      continue;
    }
    const candidates = bank.filter(
      (r) =>
        !used.has(r.itemKey) && !shared.has(r.itemKey) && args.allow(r) && tierOfLoad(loadOf(r)) === tier,
    );
    const item = pick(candidates);
    if (item) return { item, tier, load: loadOf(item) };
  }
  return null;
}
