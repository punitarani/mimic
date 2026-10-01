import type { EvidencePolicy, StateStrategy } from '@mimic/core';
import {
  argmax,
  buildState,
  type EngineDeps,
  type EvalRunRecord,
  type EvidenceItem,
  expectedIndex,
  fidelityInput,
  isPredictedKind,
  isScoredKind,
  itemAcrossPeople,
  learnsFrom,
  loadConfig,
  loadMimicData,
  loadMimicDataAt,
  makePredictor,
  needsScores,
  normalizeDist,
  P_FLOOR,
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
  surpriseOf,
  ulid,
} from '@mimic/core';

export interface ReplaySpec {
  name: string;
  predictor: string;
  strategy: StateStrategy;
  /**
   * Overrides of the config's state builder (ADR-0052): which answers survive the budget and the cap, the cap, and
   * the token budget, so one export can answer "how small can the state be, and what should it keep?".
   */
  evidencePolicy?: EvidencePolicy;
  maxEvidence?: number;
  budgetTokens?: number;
  /**
   * The evidence-view ensemble (ADR-0054): also predict every target from each of these views of the same sealed
   * evidence and pool the views log-linearly at equal weight. Rows `<predictor>@view:<strategy>` and
   * `<predictor>@pool:views` sit beside the main strategy's.
   */
  views?: StateStrategy[];
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

/** A scored row for one prediction of one question (role primary). */
function scoredRow(
  mimicId: string,
  questionId: string,
  predictorId: string,
  q: QuestionRecord,
  answer: string,
  p: PredictionResult,
): ScoredRow {
  const s = scorePrediction(q.type, p.dist, answer);
  return {
    mimicId,
    questionId,
    predictorId,
    role: 'primary',
    itemAcc: s.itemAcc,
    top1: s.top1,
    logLoss: s.logLoss,
    brier: s.brier,
    confidence: p.dist[argmax(p.dist)] ?? 0,
    costUsd: p.costUsd,
    latencyMs: p.latencyMs,
  };
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
  const overrides = {
    strategy: spec.strategy,
    ...(spec.evidencePolicy ? { evidencePolicy: spec.evidencePolicy } : {}),
    ...(spec.maxEvidence !== undefined ? { maxEvidence: spec.maxEvidence } : {}),
    ...(spec.budgetTokens !== undefined ? { budgetTokens: spec.budgetTokens } : {}),
  };
  const wantsSurprise = spec.evidencePolicy === 'surprise';
  const wantsScores = wantsSurprise || spec.evidencePolicy === 'novelty';
  /** Training answers with no stored baseline (an import), given one here so `surprise` can rank them. */
  let annotated = 0;

  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const scores = wantsScores || needsScores(cfg);
    const loaded = await loadMimicData(deps, m, { scores });
    const qById = new Map(loaded.questions.map((q) => [q.id, q]));
    const answerByQ = new Map(loaded.answers.map((a) => [a.questionId, a]));
    const items = loaded.data.evidence.filter((e) => isScoredKind(e.kind)).sort((a, b) => a.seq - b.seq);
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
    // The surprise policy ranks training answers by the baseline's log loss on them. Online sessions store it with
    // every answer; an import has none, so the same context-only baseline supplies it here, sealed by construction.
    const surpriseBySeq = new Map<number, number>();
    if (wantsSurprise) {
      const missing = train.filter((e) => e.surprise === undefined);
      const qs = missing.map((e) => qById.get(e.questionId)!);
      const preds = await predictAll(baselinePredictor, baseState, qs);
      preds.forEach((p, i) => {
        if (!p.ok) return;
        const e = missing[i]!;
        const q = qs[i]!;
        const { logLoss } = scorePrediction(q.type, p.dist, answerByQ.get(q.id)!.value);
        surpriseBySeq.set(e.seq, surpriseOf(logLoss, q.options.length));
        cost += p.costUsd;
        annotated++;
      });
    }
    const withSurprise = (e: EvidenceItem): EvidenceItem =>
      e.surprise === undefined && surpriseBySeq.has(e.seq)
        ? { ...e, surprise: surpriseBySeq.get(e.seq)! }
        : e;

    for (const k of spec.checkpoints) {
      if (k > train.length) continue;
      const targets = spec.targets === 'heldout' ? heldout : items.slice(k);
      if (!targets.length) continue;
      const beforeSeq = train[k - 1]!.seq + 1;
      const trainSeqs = new Set(train.slice(0, k).map((e) => e.seq));
      // Derived data as it stood when the next predicted question was served (all of it if there is none), sealed
      // below `beforeSeq`. Feedback takes seqs without a serve, so it never sets the as-of time (ADR-0032).
      const next = loaded.questions
        .filter((q) => q.seq !== null && q.seq >= beforeSeq && isPredictedKind(q.kind))
        .sort((a, b) => a.seq! - b.seq!)[0];
      const at = next?.stateAt ?? next?.servedAt ?? Number.MAX_SAFE_INTEGER;
      const asOf = await loadMimicDataAt(deps, m, at, beforeSeq, { scores });
      // The first k training items are the checkpoint's evidence; held-out items never enter a state. Feedback the
      // person gave before it stays in, as it did online: the traits and insights as of `at` already learned from it.
      const data = {
        ...asOf.data,
        evidence: asOf.data.evidence
          .filter((e) => trainSeqs.has(e.seq) || (e.kind === 'feedback' && e.seq < beforeSeq))
          .map(withSurprise),
      };
      const state = buildState(data, stateOptions(cfg, beforeSeq, overrides));
      const qs = targets.map((e) => qById.get(e.questionId)!);
      const preds = await predictAll(predictor, state, qs);
      const rows = rowsByK.get(k) ?? [];
      const failures = failuresByK.get(k) ?? [];
      const across = acrossByK.get(k) ?? [];
      const accs: number[] = [];
      if (spec.views?.length) {
        const byView = new Map<StateStrategy, PredictionResult[]>();
        for (const v of spec.views) {
          const vs = buildState(data, stateOptions(cfg, beforeSeq, { ...overrides, strategy: v }));
          byView.set(v, await predictAll(predictor, vs, qs));
        }
        qs.forEach((q, i) => {
          const answer = answerByQ.get(q.id)!;
          const okViews: Array<{ v: StateStrategy; p: PredictionResult }> = [];
          for (const v of spec.views!) {
            const p = byView.get(v)![i]!;
            const predictorId = `${predictor.id}@view:${v}`;
            if (!p.ok) {
              failures.push({ predictorId, role: 'primary' });
              continue;
            }
            okViews.push({ v, p });
            cost += p.costUsd;
            rows.push(scoredRow(m.id, `${q.id}@${k}`, predictorId, q, answer.value, p));
          }
          if (okViews.length) {
            const keys = q.options.map((o) => o.key);
            const dist = normalizeDist(
              Object.fromEntries(
                keys.map((key) => [
                  key,
                  Math.exp(
                    okViews.reduce((a, x) => a + Math.log(Math.max(x.p.dist[key] ?? P_FLOOR, P_FLOOR)), 0) /
                      okViews.length,
                  ),
                ]),
              ),
              keys,
            );
            rows.push(
              scoredRow(m.id, `${q.id}@${k}`, `${predictor.id}@pool:views`, q, answer.value, {
                ...okViews[0]!.p,
                dist,
                costUsd: 0,
                latencyMs: Math.max(...okViews.map((x) => x.p.latencyMs)),
              }),
            );
          }
        });
      }
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
      ...(wantsSurprise ? { surpriseAnnotated: annotated } : {}),
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
  /**
   * Served before the person narrowed their scope, or on a question it now hides (ADR-0040, ADR-0043): what they
   * withdrew is never time-travelled back into a rebuilt state, so these are counted, not checked.
   */
  rescoped: number;
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
  let rescoped = 0;
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
      const loaded = await loadMimicDataAt(deps, m, q.stateAt ?? q.servedAt, q.seq, {
        scores: needsScores(cfg),
      });
      if ((m.scopeAt !== null && q.servedAt < m.scopeAt) || loaded.scope.hiddenQuestionIds.has(q.id)) {
        n++;
        rescoped++;
        continue;
      }
      const state = buildState(loaded.data, stateOptions(cfg, q.seq, { forQuestions: [q] }));
      const eligible = loaded.data.evidence.filter((e) => e.seq < q.seq! && learnsFrom(e.kind)).length;
      // A trimmed state is rebuilt exactly unless the trimming ranked evidence by similarity to the candidate pool
      // (the `mixed` and `similar` policies); the other policies rank by exported signals alone (ADR-0052).
      const policy = cfg.stateBuilder.evidencePolicy ?? 'mixed';
      const poolRanked = policy === 'mixed' || policy === 'similar';
      const overBudget =
        cfg.stateBuilder.strategy !== 'structured' && poolRanked && state.evidence.length < eligible;
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
    rescoped,
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
