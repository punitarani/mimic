import { type Distribution, type EvalRunRecord, scorePrediction, ulid } from '@mimic/core';
import {
  type EvalRecord,
  groupBy,
  type Metrics,
  metricsOf,
  type PairedDelta,
  pairedDelta,
  toRecord,
} from './optimize/evaluate';
import type { EvalInstance, StoredPrediction } from './optimize/instances';
import { linearPool, logPool } from './pool';

export { linearPool, logPool };

/**
 * Prequential ensembles of the predictions already stored with every served question (ADR-0058): the primary and
 * each shadow predicted the same sealed state, so pooling them costs nothing new, and a weight learned from the
 * person's own earlier questions (never a later one) keeps the result as honest as the predictions it combines.
 *
 * Methods, each scored on exactly the questions the primary answered:
 * - `primary`: the stored primary, the reference;
 * - `log-pool`, `linear-pool`: every member at equal weight (a log-linear product, or a mixture);
 * - `hedge:η`: exponential weights from each member's cumulative log loss on this person's earlier questions
 *   (η = 1 is Bayesian model averaging), pooled log-linearly (`hedge-log:η`) or as a mixture (`hedge:η`);
 * - `oracle`: the single member with the lowest log loss on the person's whole record, chosen in hindsight: a
 *   bound on what choosing one model per person could give, never a result.
 */

export interface EnsembleSpec {
  name: string;
  /** Learning rates for the prequential weights; 1 is Bayesian model averaging. */
  etas: number[];
  /** Include the stored context-only baseline as a member (it then acts as shrinkage toward the profile). */
  withBaseline: boolean;
  seed: string;
}

export interface MethodSummary {
  method: string;
  all: Metrics;
  bySplit: Record<string, Metrics>;
  /** Paired against the primary on the same questions (b − a: negative log-loss deltas are improvements). */
  logLossDelta: PairedDelta;
  itemAccDelta: PairedDelta;
  /** Hedge methods: the mean weight each member ends a person's record with. */
  finalWeights: Record<string, number> | null;
}

export interface EnsembleResult {
  run: EvalRunRecord;
  people: number;
  instances: number;
  members: string[];
  methods: MethodSummary[];
}

type Member = { id: string; dist: Distribution };

/** The ok, non-fallback primary and shadows of an instance (and the baseline when asked), by predictor ID. */
function membersOf(
  inst: EvalInstance,
  withBaseline: boolean,
): { primary: StoredPrediction | null; members: Member[] } {
  const primary = inst.stored.find((p) => p.role === 'primary' && !p.fallback && p.ok) ?? null;
  const members: Member[] = [];
  const seen = new Set<string>();
  for (const p of inst.stored) {
    if (!p.ok || p.fallback) continue;
    if (p.role !== 'primary' && p.role !== 'shadow' && !(withBaseline && p.role === 'baseline')) continue;
    const id = p.role === 'baseline' ? `${p.predictorId}|baseline` : p.predictorId;
    if (seen.has(id)) continue;
    seen.add(id);
    members.push({ id, dist: p.dist });
  }
  return { primary, members };
}

/** Exponential weights from cumulative log loss: w_j ∝ exp(−η · L_j). */
export function hedgeWeights(loss: Map<string, number>, eta: number, ids: string[]): Map<string, number> {
  const min = Math.min(...ids.map((id) => loss.get(id) ?? 0));
  const raw = ids.map((id) => Math.exp(-eta * ((loss.get(id) ?? 0) - min)));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return new Map(ids.map((id, i) => [id, raw[i]! / sum]));
}

const stamp = (dist: Distribution, predictorId: string) =>
  ({ dist, ok: true, costUsd: 0, latencyMs: 0, modelSnapshot: `derived:${predictorId}` }) as const;

export function ensembleFromStored(
  instances: EvalInstance[],
  spec: EnsembleSpec,
): Omit<EnsembleResult, 'run'> {
  const online = instances
    .filter((i) => i.mode === 'online')
    .sort((a, b) => a.mimicId.localeCompare(b.mimicId) || a.seq - b.seq);
  const methods = [
    'primary',
    'log-pool',
    'linear-pool',
    ...spec.etas.flatMap((e) => [`hedge:${e}`, `hedge-log:${e}`]),
    'oracle',
  ];
  const records = new Map<string, EvalRecord[]>(methods.map((m) => [m, []]));
  const memberIds = new Set<string>();
  const finalWeights = new Map<string, Map<string, number[]>>();

  for (const [, insts] of groupBy(online, (i) => i.mimicId)) {
    // Cumulative log loss per member over this person's earlier questions: the only thing a weight may depend on. A
    // member is charged the uniform loss for every earlier question it did not predict (including those before it
    // first appeared), so absence is neither rewarded nor punished.
    const loss = new Map<string, number>();
    let uniformSoFar = 0;
    const lossOf = (id: string) => loss.get(id) ?? uniformSoFar;
    // Hindsight: the member with the lowest total loss over the whole record (every question it answered).
    const total = new Map<string, { loss: number; n: number }>();
    for (const inst of insts) {
      for (const m of membersOf(inst, spec.withBaseline).members) {
        const l = scorePrediction(inst.question.type, m.dist, inst.answer).logLoss;
        const t = total.get(m.id) ?? { loss: 0, n: 0 };
        total.set(m.id, { loss: t.loss + l, n: t.n + 1 });
      }
    }
    const oracleId = [...total.entries()]
      .filter(([, t]) => t.n === insts.length)
      .sort((a, b) => a[1].loss - b[1].loss)[0]?.[0];

    for (const inst of insts) {
      const { primary, members } = membersOf(inst, spec.withBaseline);
      if (!primary || !members.length) continue;
      const keys = inst.question.options.map((o) => o.key);
      for (const m of members) memberIds.add(m.id);
      const ids = members.map((m) => m.id);
      const add = (method: string, dist: Distribution) =>
        records.get(method)!.push(toRecord(inst, method, `ensemble:${method}`, stamp(dist, method)));

      add('primary', primary.dist);
      add(
        'log-pool',
        logPool(
          members.map((m) => ({ dist: m.dist, w: 1 })),
          keys,
        ),
      );
      add(
        'linear-pool',
        linearPool(
          members.map((m) => ({ dist: m.dist, w: 1 })),
          keys,
        ),
      );
      const earlier = new Map(ids.map((id) => [id, lossOf(id)]));
      for (const eta of spec.etas) {
        const w = hedgeWeights(earlier, eta, ids);
        const weighted = members.map((m) => ({ dist: m.dist, w: w.get(m.id)! }));
        add(`hedge:${eta}`, linearPool(weighted, keys));
        add(`hedge-log:${eta}`, logPool(weighted, keys));
        if (inst === insts.at(-1)) {
          for (const method of [`hedge:${eta}`, `hedge-log:${eta}`]) {
            const fw = finalWeights.get(method) ?? new Map<string, number[]>();
            for (const m of members) fw.set(m.id, [...(fw.get(m.id) ?? []), w.get(m.id)!]);
            finalWeights.set(method, fw);
          }
        }
      }
      const oracle = members.find((m) => m.id === oracleId);
      if (oracle) add('oracle', oracle.dist);

      // Only now, after the question is scored, does its loss reach the weights (prequential, invariant 1).
      const uniform = Math.log(keys.length);
      for (const id of new Set([...loss.keys(), ...ids])) {
        const m = members.find((x) => x.id === id);
        const l = m ? scorePrediction(inst.question.type, m.dist, inst.answer).logLoss : uniform;
        loss.set(id, lossOf(id) + l);
      }
      uniformSoFar += uniform;
    }
  }

  const primaryRecs = records.get('primary')!;
  const summaries: MethodSummary[] = methods.map((method) => {
    const rs = records.get(method)!;
    const bySplit = Object.fromEntries(
      [...groupBy(rs, (r) => r.split).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, metricsOf(v)]),
    );
    const fw = finalWeights.get(method);
    return {
      method,
      all: metricsOf(rs),
      bySplit,
      logLossDelta: pairedDelta(primaryRecs, rs, 'logLoss', `${spec.seed}:${method}:ll`),
      itemAccDelta: pairedDelta(primaryRecs, rs, 'itemAcc', `${spec.seed}:${method}:acc`),
      finalWeights: fw
        ? Object.fromEntries(
            [...fw.entries()].map(([id, ws]) => [id, ws.reduce((a, b) => a + b, 0) / ws.length]),
          )
        : null,
    };
  });
  return {
    people: new Set(primaryRecs.map((r) => r.mimicId)).size,
    instances: primaryRecs.length,
    members: [...memberIds].sort(),
    methods: summaries,
  };
}

export function ensembleRun(
  instances: EvalInstance[],
  spec: EnsembleSpec,
  datasetHash: string,
  now: number,
): EnsembleResult {
  const r = ensembleFromStored(instances, spec);
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { ...spec, kind: 'ensemble' },
    datasetHash,
    status: 'done',
    metrics: { people: r.people, instances: r.instances, members: r.members, methods: r.methods },
    r2ReportKey: null,
    createdAt: now,
  };
  return { run, ...r };
}

export function renderEnsemble(m: Record<string, unknown>): string[] {
  const f3 = (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : '—');
  const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');
  const delta = (d: PairedDelta, scale = 1, unit = '') =>
    d.n
      ? `${(d.mean * scale).toFixed(unit ? 1 : 3)}${unit} [${(d.ciLow * scale).toFixed(unit ? 1 : 3)}, ${(d.ciHigh * scale).toFixed(unit ? 1 : 3)}]`
      : '—';
  const methods = (m.methods as MethodSummary[]) ?? [];
  const out = [
    `People: ${String(m.people)} · questions: ${String(m.instances)} · members: ${((m.members as string[]) ?? []).map((x) => `\`${x}\``).join(', ')}`,
    '',
    "Weights come only from the person's earlier questions; `oracle` picks the best single member in hindsight and is a bound, not a result.",
    'Deltas are paired against the primary with 90% bootstrap intervals; a negative log-loss delta is an improvement.',
    '',
    '| Method | n | Log loss | Accuracy | Top-1 | Brier | ECE | Δ log loss | Δ accuracy (pts) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...methods.map(
      (s) =>
        `| ${s.method} | ${s.all.n} | ${f3(s.all.logLoss)} | ${pct(s.all.itemAcc)} | ${pct(s.all.top1)} | ${f3(s.all.brier)} | ${f3(s.all.ece)} | ${delta(s.logLossDelta)} | ${delta(s.itemAccDelta, 100, '')} |`,
    ),
    '',
  ];
  const splits = [...new Set(methods.flatMap((s) => Object.keys(s.bySplit)))].sort();
  if (splits.length > 1) {
    out.push(
      '## By split',
      '',
      '| Method | Split | n | Log loss | Accuracy |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const s of methods)
      for (const sp of splits) {
        const v = s.bySplit[sp];
        if (v) out.push(`| ${s.method} | ${sp} | ${v.n} | ${f3(v.logLoss)} | ${pct(v.itemAcc)} |`);
      }
    out.push('');
  }
  const weighted = methods.filter((s) => s.finalWeights);
  if (weighted.length) {
    out.push(
      '## Final weights (mean over people)',
      '',
      '| Method | Member | Weight |',
      '| --- | --- | --- |',
    );
    for (const s of weighted)
      for (const [id, w] of Object.entries(s.finalWeights!).sort((a, b) => b[1] - a[1]))
        out.push(`| ${s.method} | \`${id}\` | ${f3(w)} |`);
    out.push('');
  }
  return out;
}
