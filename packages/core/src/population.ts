import { entropy } from './distribution';
import { mean } from './metrics';
import type { Domain, QType } from './types';

/**
 * Cross-person item statistics (docs/SELECTION.md §7): aggregate-only rows over research-consented, dev-split mimics,
 * used to rank pooled candidates and nothing else. No free text and no per-person data is stored (PLAN §3.8).
 */

export type ItemStatKind = 'item' | 'archetype';

export interface ItemStatRecord {
  /** `item:{itemKey}` or `arch:{facetId}|{domain}|{type}`. */
  key: string;
  kind: ItemStatKind;
  nPeople: number;
  nAnswers: number;
  /** Normalised entropy of the population's answers (items only): how much people differ on it. */
  answerEntropy: number | null;
  /** Mean 1 − item accuracy of the context-only baseline: how often the stereotype gets it wrong. */
  baselineError: number;
  /** Mean 1 − item accuracy of the sealed primary. */
  primaryError: number;
  /** Mean primary log loss divided by log|options|. */
  surprise: number;
  /** Mean paired primary − baseline item accuracy. */
  lift: number | null;
  meanLatencyMs: number;
  updatedAt: number;
}

export interface ScoredItemRow {
  mimicId: string;
  itemKey: string | null;
  facetIds: string[];
  domain: Domain;
  type: QType;
  answer: string;
  nOptions: number;
  primaryItemAcc: number;
  primaryLogLoss: number;
  baselineItemAcc: number | null;
  latencyMs: number;
}

export const POP_MIN_PEOPLE = 5;
/** Prior weight, in answers, pulling an item's informativeness toward neutral (½). */
export const POP_PRIOR_WEIGHT = 20;

export const itemStatKey = {
  item: (itemKey: string) => `item:${itemKey}`,
  archetype: (facetId: string, domain: Domain, type: QType) => `arch:${facetId}|${domain}|${type}`,
};

function aggregate(key: string, kind: ItemStatKind, rows: ScoredItemRow[], now: number): ItemStatRecord {
  const baselines = rows.map((r) => r.baselineItemAcc).filter((x): x is number => x !== null);
  const paired = rows.filter((r) => r.baselineItemAcc !== null);
  let answerEntropy: number | null = null;
  if (kind === 'item') {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.answer] = (counts[r.answer] ?? 0) + 1;
    const dist = Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, c / rows.length]));
    const nOptions = Math.max(2, ...rows.map((r) => r.nOptions));
    answerEntropy = Math.min(1, entropy(dist) / Math.log(nOptions));
  }
  return {
    key,
    kind,
    nPeople: new Set(rows.map((r) => r.mimicId)).size,
    nAnswers: rows.length,
    answerEntropy,
    baselineError: baselines.length ? mean(baselines.map((b) => 1 - b)) : 0.5,
    primaryError: mean(rows.map((r) => 1 - r.primaryItemAcc)),
    surprise: mean(rows.map((r) => Math.min(1, r.primaryLogLoss / Math.log(Math.max(2, r.nOptions))))),
    lift: paired.length ? mean(paired.map((r) => r.primaryItemAcc - r.baselineItemAcc!)) : null,
    meanLatencyMs: mean(rows.map((r) => r.latencyMs)),
    updatedAt: now,
  };
}

/**
 * Groups scored rows by item key and by archetype (one group per facet of each row). Groups with fewer than
 * `minPeople` people are dropped before anything is returned, so no stored row is one person's numbers.
 */
export function computeItemStats(
  rows: ScoredItemRow[],
  now: number,
  minPeople = POP_MIN_PEOPLE,
): ItemStatRecord[] {
  const items = new Map<string, ScoredItemRow[]>();
  const archs = new Map<string, ScoredItemRow[]>();
  const add = (map: Map<string, ScoredItemRow[]>, k: string, r: ScoredItemRow) => {
    const g = map.get(k);
    if (g) g.push(r);
    else map.set(k, [r]);
  };
  for (const r of rows) {
    if (r.itemKey) add(items, itemStatKey.item(r.itemKey), r);
    for (const f of r.facetIds) add(archs, itemStatKey.archetype(f, r.domain, r.type), r);
  }
  return [
    ...[...items.entries()].map(([k, g]) => aggregate(k, 'item', g, now)),
    ...[...archs.entries()].map(([k, g]) => aggregate(k, 'archetype', g, now)),
  ]
    .filter((s) => s.nPeople >= minPeople)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function shrink(raw: number, n: number, priorWeight: number): number {
  return (n * raw + priorWeight * 0.5) / (n + priorWeight);
}

/**
 * How informative a candidate is expected to be, from the population, in [0, 1]; null when too few people have
 * answered anything like it (no effect on selection). Items: ½·answer entropy + ½·baseline error. Generated
 * questions: the mean over their facets' archetypes of ½·surprise + ½·baseline error. Both shrunk toward ½.
 */
export function populationScore(
  q: { itemKey?: string | null; facetIds: string[]; domain: Domain; type: QType },
  stats: ReadonlyMap<string, ItemStatRecord>,
  opts: { minPeople?: number; priorWeight?: number } = {},
): number | null {
  const minPeople = opts.minPeople ?? POP_MIN_PEOPLE;
  const priorWeight = opts.priorWeight ?? POP_PRIOR_WEIGHT;
  if (q.itemKey) {
    const s = stats.get(itemStatKey.item(q.itemKey));
    if (s && s.nPeople >= minPeople)
      return shrink(0.5 * (s.answerEntropy ?? 0.5) + 0.5 * s.baselineError, s.nAnswers, priorWeight);
  }
  const parts: number[] = [];
  for (const f of q.facetIds) {
    const s = stats.get(itemStatKey.archetype(f, q.domain, q.type));
    if (s && s.nPeople >= minPeople)
      parts.push(shrink(0.5 * s.surprise + 0.5 * s.baselineError, s.nAnswers, priorWeight));
  }
  return parts.length ? mean(parts) : null;
}
