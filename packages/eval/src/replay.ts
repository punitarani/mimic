import type { StateStrategy } from '@mimic/core';
import {
  argmax,
  buildState,
  type EngineDeps,
  type EvalRunRecord,
  expectedIndex,
  fidelityInput,
  itemAcrossPeople,
  learnsFrom,
  loadConfig,
  loadMimicData,
  loadMimicDataAt,
  makePredictor,
  type PersonState,
  type PredictionResult,
  type PredictorMetrics,
  predictorMetrics,
  type Question,
  type QuestionRecord,
  quantile,
  type ScoredRow,
  scorePrediction,
  seededRng,
  selfConsistency,
  shuffle,
  stateOptions,
  ulid,
} from '@mimic/core';

export interface ReplaySpec {
  name: string;
  predictor: string;
  strategy: StateStrategy;
  checkpoints: number[];
  split: 'dev' | 'test' | 'all';
  /** `later`: every later non-repeat item (PLAN §12.3). `heldout`: only held-out items (e.g. Twin-2K-500 wave 4). */
  targets: 'later' | 'heldout';
  limitPeople?: number;
  seed: string;
}

export interface CheckpointMetrics {
  k: number;
  people: number;
  predictors: PredictorMetrics[];
  fidelity: number | null;
  acrossPeople: ReturnType<typeof itemAcrossPeople>;
}

export interface ReplayResult {
  run: EvalRunRecord;
  checkpoints: CheckpointMetrics[];
  costPerPersonUsd: number;
  modelSnapshots: string[];
}

export const HELDOUT_PREFIX = 'twin2k/w4/';
const JEV_CHUNK = 40;

/** Predicts in chunks so a Jev request stays well inside its 32K context. */
async function predictAll(predictor: ReturnType<typeof makePredictor>, state: PersonState, qs: Question[]) {
  const out: PredictionResult[] = [];
  for (let i = 0; i < qs.length; i += JEV_CHUNK)
    out.push(...(await predictor.predict(state, qs.slice(i, i + JEV_CHUNK))));
  return out;
}

/** Numeric value of an answer for across-person metrics: score index, yes = 1, or 2-option choice index. */
function itemValue(q: QuestionRecord, key: string): number | null {
  if (q.type === 'score') return Number(key);
  if (q.type === 'noul') return key === 'yes' ? 1 : 0;
  if (q.options.length === 2) return q.options.findIndex((o) => o.key === key);
  return null;
}

function predictedValue(q: QuestionRecord, dist: Record<string, number>): number | null {
  if (q.type === 'score') return expectedIndex(dist);
  if (q.type === 'noul') return dist.yes ?? null;
  if (q.options.length === 2) return dist[q.options[1]!.key] ?? null;
  return null;
}

/**
 * `mimic-eval replay` (PLAN §12.3): for each person and checkpoint k, build the state from the first k evidence
 * items and predict every later non-repeat item (or the held-out items), plus a context-only baseline.
 */
export async function replay(deps: EngineDeps, spec: ReplaySpec, datasetHash: string): Promise<ReplayResult> {
  const all = await deps.store.listMimics({ consentResearch: true });
  let mimics = all.filter((m) => spec.split === 'all' || m.split === spec.split);
  mimics = shuffle(mimics, seededRng(spec.seed)).slice(0, spec.limitPeople ?? mimics.length);
  const ctx = { purpose: 'eval.replay' };
  const predictor = makePredictor(deps.gateway, spec.predictor, ctx);
  const baselinePredictor = makePredictor(deps.gateway, spec.predictor, { purpose: 'eval.replay.baseline' });
  const rowsByK = new Map<number, ScoredRow[]>();
  const failuresByK = new Map<number, Array<{ predictorId: string; role: string }>>();
  const acrossByK = new Map<number, Array<{ itemKey: string; predicted: number; actual: number }>>();
  const fidelityByK = new Map<number, number[]>();
  const snapshots = new Set<string>();
  let cost = 0;

  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const loaded = await loadMimicData(deps, m);
    const qById = new Map(loaded.questions.map((q) => [q.id, q]));
    const answerByQ = new Map(loaded.answers.map((a) => [a.questionId, a]));
    // Checkpoints count session answers only; person-written feedback stays out of replayed states (ADR-0027).
    const items = loaded.data.evidence
      .filter((e) => e.kind === 'anchor' || e.kind === 'adaptive')
      .sort((a, b) => a.seq - b.seq);
    const isHeldout = (qid: string) => qById.get(qid)?.itemKey?.startsWith(HELDOUT_PREFIX) ?? false;
    const train = spec.targets === 'heldout' ? items.filter((e) => !isHeldout(e.questionId)) : items;
    const heldout = items.filter((e) => isHeldout(e.questionId));
    const { repeatAgreements } = fidelityInput([], loaded.questions, loaded.answers);
    const c = selfConsistency(repeatAgreements);

    const allTargets = spec.targets === 'heldout' ? heldout : items.slice(Math.min(...spec.checkpoints));
    const baseState = buildState(loaded.data, stateOptions(cfg, 0, { contextOnly: true }));
    const baseQs = allTargets.map((e) => qById.get(e.questionId)!);
    const basePreds = await predictAll(baselinePredictor, baseState, baseQs);
    const baseByQ = new Map(baseQs.map((q, i) => [q.id, basePreds[i]!]));

    for (const k of spec.checkpoints) {
      if (k > train.length) continue;
      const targets = spec.targets === 'heldout' ? heldout : items.slice(k);
      if (!targets.length) continue;
      const beforeSeq = train[k - 1]!.seq + 1;
      const trainSeqs = new Set(train.slice(0, k).map((e) => e.seq));
      // Derived data as it stood when question `beforeSeq` was served (all of it if there is none), sealed below it.
      const next = loaded.questions.find((q) => q.seq === beforeSeq);
      const at = next?.stateAt ?? next?.servedAt ?? Number.MAX_SAFE_INTEGER;
      const asOf = await loadMimicDataAt(deps, m, at, beforeSeq);
      // Only the first k training items count as evidence; held-out items never enter a state.
      const data = { ...asOf.data, evidence: asOf.data.evidence.filter((e) => trainSeqs.has(e.seq)) };
      const state = buildState(data, stateOptions(cfg, beforeSeq, { strategy: spec.strategy }));
      const qs = targets.map((e) => qById.get(e.questionId)!);
      const preds = await predictAll(predictor, state, qs);
      const rows = rowsByK.get(k) ?? [];
      const failures = failuresByK.get(k) ?? [];
      const across = acrossByK.get(k) ?? [];
      const accs: number[] = [];
      qs.forEach((q, i) => {
        const answer = answerByQ.get(q.id)!;
        for (const [role, p] of [
          ['replay', preds[i]!],
          ['baseline', baseByQ.get(q.id)!],
        ] as const) {
          const predictorId = role === 'replay' ? predictor.id : `${baselinePredictor.id}`;
          if (!p.ok) {
            failures.push({ predictorId, role: role === 'replay' ? 'primary' : 'baseline' });
            continue;
          }
          if (role === 'replay') cost += p.costUsd;
          snapshots.add(p.modelSnapshot);
          const s = scorePrediction(q.type, p.dist, answer.value);
          rows.push({
            mimicId: m.id,
            questionId: `${q.id}@${k}`,
            predictorId,
            role: role === 'replay' ? 'primary' : 'baseline',
            itemAcc: s.itemAcc,
            top1: s.top1,
            logLoss: s.logLoss,
            brier: s.brier,
            confidence: p.dist[argmax(p.dist)] ?? 0,
            costUsd: p.costUsd,
            latencyMs: p.latencyMs,
          });
          if (role === 'replay') {
            accs.push(s.itemAcc);
            const pv = predictedValue(q, p.dist);
            const av = itemValue(q, answer.value);
            if (q.itemKey && pv !== null && av !== null)
              across.push({ itemKey: q.itemKey, predicted: pv, actual: av });
          }
        }
      });
      rowsByK.set(k, rows);
      failuresByK.set(k, failures);
      acrossByK.set(k, across);
      if (accs.length) {
        const acc = accs.reduce((a, b) => a + b, 0) / accs.length;
        fidelityByK.set(k, [...(fidelityByK.get(k) ?? []), Math.min(1, acc / c)]);
      }
    }
    cost += basePreds.reduce((a, p) => a + p.costUsd, 0);
  }

  const checkpoints: CheckpointMetrics[] = spec.checkpoints
    .filter((k) => rowsByK.has(k))
    .map((k) => {
      const fid = fidelityByK.get(k) ?? [];
      return {
        k,
        people: new Set((rowsByK.get(k) ?? []).map((r) => r.mimicId)).size,
        predictors: predictorMetrics(rowsByK.get(k) ?? [], failuresByK.get(k) ?? []),
        fidelity: fid.length ? fid.reduce((a, b) => a + b, 0) / fid.length : null,
        acrossPeople: itemAcrossPeople(acrossByK.get(k) ?? []),
      };
    });
  const people = mimics.length || 1;
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { ...spec, kind: 'replay' },
    datasetHash,
    status: 'done',
    metrics: {
      checkpoints,
      costPerPersonUsd: cost / people,
      people: mimics.length,
      modelSnapshots: [...snapshots].sort(),
    },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, checkpoints, costPerPersonUsd: cost / people, modelSnapshots: [...snapshots].sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// Online reproduction (M7 acceptance)
// ---------------------------------------------------------------------------------------------------------------

export interface ReproductionResult {
  run: EvalRunRecord;
  n: number;
  /** Predictions whose sealed state is fully determined by the export (pinned, within budget). */
  checkable: number;
  /** Served before `stateAt` existed: rebuilt as of servedAt, approximately (ADR-0017). */
  legacy: number;
  /** Over the evidence budget: retrieval ranked evidence against the candidate pool (not exported), so only the
   * sealed state blob in R2 reproduces these exactly. */
  truncated: number;
  /** Over checkable predictions. */
  stateHashMatchRate: number;
  snapshotMatchRate: number;
  argmaxAgreement: number;
  meanTvd: number;
  p95Tvd: number;
  onlineAccuracy: number;
  replayAccuracy: number;
  meanAbsItemAccDelta: number;
  pass: boolean;
}

export const REPRODUCTION_TOLERANCE = {
  meanAbsItemAccDelta: 0.05,
  argmaxAgreement: 0.9,
  stateHashMatchRate: 1,
};

/**
 * Rebuilds each online primary's sealed state from the exported data as of its serve time, checks the state hash,
 * re-predicts with the same predictor, and compares scores. Needs an export made with --keep-identity, since states
 * include the name and location.
 */
export async function reproduceOnline(
  deps: EngineDeps,
  opts: { limitPeople?: number; seed: string; name: string },
  datasetHash: string,
): Promise<ReproductionResult> {
  const mimics = shuffle(await deps.store.listMimics({ consentResearch: true }), seededRng(opts.seed)).slice(
    0,
    opts.limitPeople,
  );
  let n = 0;
  let checkable = 0;
  let legacy = 0;
  let truncated = 0;
  let hashMatch = 0;
  let snapMatch = 0;
  let agree = 0;
  const tvds: number[] = [];
  const onlineAcc: number[] = [];
  const replayAcc: number[] = [];
  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const qs = new Map((await deps.store.listQuestions(m.id)).map((q) => [q.id, q]));
    const answers = new Map((await deps.store.listAnswers(m.id)).map((a) => [a.questionId, a]));
    const primaries = (await deps.store.listPredictions({ mimicId: m.id, roles: ['primary'] })).filter(
      (p) => p.ok && !p.fallback,
    );
    for (const p of primaries) {
      const q = qs.get(p.questionId);
      const a = answers.get(p.questionId);
      if (!q || q.seq === null || q.servedAt === null || !a) continue;
      // Questions served before stateAt existed fall back to servedAt (approximate, ADR-0017).
      const loaded = await loadMimicDataAt(deps, m, q.stateAt ?? q.servedAt, q.seq);
      const state = buildState(loaded.data, stateOptions(cfg, q.seq, { forQuestions: [q] }));
      const eligible = loaded.data.evidence.filter((e) => e.seq < q.seq! && learnsFrom(e.kind)).length;
      const overBudget = cfg.stateBuilder.strategy !== 'structured' && state.evidence.length < eligible;
      n++;
      if (q.stateAt === null) legacy++;
      else if (overBudget) truncated++;
      else {
        checkable++;
        if (state.meta.stateHash === p.stateHash) hashMatch++;
      }
      const predictor = makePredictor(deps.gateway, p.predictorId, { purpose: 'eval.reproduce' });
      const [r] = await predictor.predict(state, [q]);
      if (!r?.ok) continue;
      if (r.modelSnapshot === p.modelSnapshot) snapMatch++;
      const keys = q.options.map((o) => o.key);
      tvds.push(0.5 * keys.reduce((s, k) => s + Math.abs((r.dist[k] ?? 0) - (p.dist[k] ?? 0)), 0));
      if (argmax(r.dist) === argmax(p.dist)) agree++;
      onlineAcc.push(scorePrediction(q.type, p.dist, a.value).itemAcc);
      replayAcc.push(scorePrediction(q.type, r.dist, a.value).itemAcc);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const deltas = onlineAcc.map((x, i) => Math.abs(x - replayAcc[i]!));
  const res = {
    n,
    checkable,
    legacy,
    truncated,
    stateHashMatchRate: checkable ? hashMatch / checkable : 0,
    snapshotMatchRate: tvds.length ? snapMatch / tvds.length : 0,
    argmaxAgreement: tvds.length ? agree / tvds.length : 0,
    meanTvd: mean(tvds),
    p95Tvd: quantile(tvds, 0.95),
    onlineAccuracy: mean(onlineAcc),
    replayAccuracy: mean(replayAcc),
    meanAbsItemAccDelta: mean(deltas),
  };
  const pass =
    checkable > 0 &&
    res.stateHashMatchRate >= REPRODUCTION_TOLERANCE.stateHashMatchRate &&
    res.argmaxAgreement >= REPRODUCTION_TOLERANCE.argmaxAgreement &&
    res.meanAbsItemAccDelta <= REPRODUCTION_TOLERANCE.meanAbsItemAccDelta;
  const run: EvalRunRecord = {
    id: ulid(),
    name: opts.name,
    spec: { kind: 'reproduce', ...opts, tolerance: REPRODUCTION_TOLERANCE },
    datasetHash,
    status: 'done',
    metrics: { ...res, pass },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, ...res, pass };
}
