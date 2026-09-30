import { readFileSync } from 'node:fs';
import {
  type DraftQuestion,
  type Gate,
  type Gateway,
  gateQuestions,
  gateSet,
  generateCandidates,
  getOntology,
  JEV_MODEL,
  type PipelineConfig,
  SENSITIVE_AREAS,
  SensitiveArea,
  splitQuota,
} from '@mimic/core';
import { z } from 'zod';

const Labeled = z.object({
  id: z.string(),
  items: z.array(
    z.object({
      prompt: z.string(),
      type: z.enum(['choice', 'noul', 'score']),
      options: z.array(z.string()),
      /**
       * Sensitive areas the item is tagged with, as a consented direct question would be (ADR-0042): under gates.v3
       * the `sensitive` gate asks only about the other areas. Empty for ordinary items.
       */
      tagged: z.array(SensitiveArea).default([]),
      /** Where the item came from, for the report: `handwritten`, `reserve.v2`, or a generator run such as `gen.v3`. */
      source: z.string().optional(),
      /** True when the item has the problem the gate looks for (for `quick` and `concrete`: when it is quick or concrete). */
      labels: z.object({
        ambiguous: z.boolean(),
        sensitive: z.boolean(),
        leading: z.boolean(),
        quick: z.boolean(),
        concrete: z.boolean().optional(),
        demeaning: z.boolean().optional(),
      }),
    }),
  ),
});
export type LabeledSet = z.infer<typeof Labeled>;

export interface GateCalibration {
  gate: Gate;
  auc: number;
  /** Best threshold by balanced accuracy; for `quick` the candidate fails when p < threshold, otherwise p > threshold. */
  threshold: number;
  balancedAccuracy: number;
  positives: number;
  negatives: number;
  /** The gate set's threshold today, and its balanced accuracy on this set. */
  current?: number;
  currentBalancedAccuracy?: number;
}

/** Area under the ROC curve (probability that a random positive scores above a random negative). */
export function auc(scores: Array<{ p: number; y: boolean }>): number {
  const pos = scores.filter((s) => s.y);
  const neg = scores.filter((s) => !s.y);
  if (!pos.length || !neg.length) return Number.NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function bestThreshold(scores: Array<{ p: number; y: boolean }>): {
  threshold: number;
  balancedAccuracy: number;
} {
  let best = { threshold: 0.5, balancedAccuracy: 0 };
  for (let t = 0.05; t <= 0.951; t += 0.01) {
    const tp = scores.filter((s) => s.y && s.p > t).length;
    const tn = scores.filter((s) => !s.y && s.p <= t).length;
    const P = scores.filter((s) => s.y).length || 1;
    const N = scores.filter((s) => !s.y).length || 1;
    const ba = (tp / P + tn / N) / 2;
    if (ba > best.balancedAccuracy + 1e-9)
      best = { threshold: Math.round(t * 100) / 100, balancedAccuracy: ba };
  }
  return best;
}

/** One labelled item with the probabilities Jev gave it. */
export interface GateRow {
  item: LabeledSet['items'][number];
  p: Partial<Record<Gate, number>>;
}

/**
 * Runs a gate set on a hand-labelled set and reports, per gate, the AUC, the best threshold by balanced accuracy and
 * how the set's current threshold does (PLAN §9.4). Gates whose label is missing on every item are left out.
 */
export async function calibrateGates(
  gateway: Gateway,
  path: string,
  version = 'gates.v2',
): Promise<{ gates: GateCalibration[]; rows: GateRow[] }> {
  const set = Labeled.parse(JSON.parse(readFileSync(path, 'utf8')));
  const gs = gateSet(version);
  const rows: GateRow[] = await Promise.all(
    set.items.map(async (item) => {
      const forbidden = SENSITIVE_AREAS.filter((a) => !item.tagged.includes(a));
      const questions = gateQuestions(version, forbidden);
      const res = await gateway.decide(
        { purpose: 'eval.gates' },
        {
          model: JEV_MODEL,
          state: { question: { prompt: item.prompt, type: item.type, options: item.options } },
          questions,
        },
      );
      const p: Partial<Record<Gate, number>> = {};
      for (const g of Object.keys(questions) as Gate[]) {
        const a = res.answers[g];
        p[g] = a?.type === 'noul' ? a.p : Number.NaN;
      }
      return { item, p };
    }),
  );
  const out: GateCalibration[] = [];
  for (const gate of gs.gates) {
    // For gates that fail below a threshold (`quick`, `concrete`) the bad outcome is the label being false.
    const below = gs.thresholds[gate]?.failIf === 'below';
    const scored = rows.filter((r) => r.item.labels[gate] !== undefined && r.p[gate] !== undefined);
    if (!scored.length) continue;
    const scores = scored.map((r) => ({
      p: below ? 1 - r.p[gate]! : r.p[gate]!,
      y: below ? !r.item.labels[gate] : r.item.labels[gate]!,
    }));
    const best = bestThreshold(scores);
    const current = gs.thresholds[gate]?.p;
    out.push({
      gate,
      auc: auc(scores),
      threshold: below ? Math.round((1 - best.threshold) * 100) / 100 : best.threshold,
      balancedAccuracy: best.balancedAccuracy,
      positives: scores.filter((s) => s.y).length,
      negatives: scores.filter((s) => !s.y).length,
      ...(current !== undefined
        ? { current, currentBalancedAccuracy: balancedAccuracyAt(scores, below ? 1 - current : current) }
        : {}),
    });
  }
  return { gates: out, rows };
}

/** Balanced accuracy of "bad when p > t" on scored items. */
export function balancedAccuracyAt(scores: Array<{ p: number; y: boolean }>, t: number): number {
  const P = scores.filter((s) => s.y).length || 1;
  const N = scores.filter((s) => !s.y).length || 1;
  const tp = scores.filter((s) => s.y && s.p > t).length;
  const tn = scores.filter((s) => !s.y && s.p <= t).length;
  return (tp / P + tn / N) / 2;
}

/**
 * Samples raw generator drafts, before any gate, for hand labelling (ADR-0042). Each batch targets a different
 * slice of the config's facets, every category and every sensitive area included, so the labelled set grows with
 * what the generator actually writes.
 */
export async function sampleDrafts(
  gateway: Gateway,
  cfg: PipelineConfig,
  opts: { batches: number; perBatch: number; occupation?: string },
): Promise<Array<DraftQuestion & { promptVersion: string; tagged: SensitiveArea[] }>> {
  const facets = getOntology(cfg.ontologyVersion);
  const out: Array<DraftQuestion & { promptVersion: string; tagged: SensitiveArea[] }> = [];
  const byArea = new Map(facets.filter((f) => f.sensitive).map((f) => [f.id, f.sensitive!]));
  for (let b = 0; b < opts.batches; b++) {
    const targets = facets.filter((_, i) => i % opts.batches === b).slice(0, 6);
    const gen = await generateCandidates(
      gateway,
      { purpose: 'eval.drafts' },
      {
        model: cfg.generator.model,
        reasoningEffort: cfg.generator.reasoningEffort,
        promptVersion: cfg.generator.promptVersion,
        facets,
        targets: targets.map((f) => f.id),
        targetDetails: targets.map((f) => ({
          id: f.id,
          name: f.name,
          low: f.low,
          high: f.high,
          reason: 'unexplored' as const,
          label: null,
          certainty: null,
          need: 1,
        })),
        avoid: [],
        quota: splitQuota(cfg.generator.domainMix, opts.perBatch),
        identity: { occupation: opts.occupation ?? 'Nurse', location: 'Lisbon, PT' },
        traitSummary: '',
        recentPrompts: [],
        n: opts.perBatch,
        sensitiveAllowed: [...byArea.keys()],
      },
    );
    for (const d of gen.drafts)
      out.push({
        ...d,
        promptVersion: cfg.generator.promptVersion,
        tagged: [...new Set(d.facetIds.flatMap((f) => byArea.get(f) ?? []))],
      });
  }
  return out;
}
