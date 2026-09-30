import { argmax } from '../distribution';
import {
  type CallMetrics,
  callMetrics,
  type PredictorMetrics,
  predictorMetrics,
  quantile,
  questionsToSustain,
  type ScoredRow,
} from '../metrics';
import type { ConfigRecord, EvalRunRecord, ExperimentRecord } from '../store';
import { type EngineDeps, loadConfig } from './deps';

export interface ArmCurve {
  arm: string;
  mimics: number;
  /** Mean fidelity after k answered questions (anchor + adaptive + repeats). */
  points: Array<{ k: number; fidelity: number; n: number }>;
  meanSpendUsd: number;
  meanFinalFidelity: number | null;
  /** E3 (PLAN §12.7): mean fidelity after 20 answered questions, over mimics that got that far. */
  fidelityAt20: number | null;
  /**
   * E3: median number of answered questions after which fidelity is ≥ FIDELITY_TARGET and stays there through the
   * mimic's last answer (a single early crossing is noise), over mimics that got there.
   */
  questionsToTarget: number | null;
  reachedTarget: number;
}

export const FIDELITY_TARGET = 0.75;

export interface InvariantReport {
  servedQuestions: number;
  /** Served non-repeat questions missing a primary, a baseline, or any expected shadow. */
  incomplete: number;
  /** Served in the last PENDING_WINDOW_MS; shadows may still be running. */
  pending: number;
  /** Shadows whose stateHash differs from the primary's. */
  shadowStateMismatches: number;
  /** Baselines whose evidenceSeqMax is not 0 (context-only). */
  nonContextBaselines: number;
  /** Predictions whose evidenceSeqMax ≥ the question's seq (a sealing violation). */
  sealingViolations: number;
}

export const PENDING_WINDOW_MS = 15 * 60 * 1000;

export interface LabOverview {
  scope: 'consented' | 'all';
  mimics: number;
  predictors: PredictorMetrics[];
  calls: CallMetrics[];
  arms: ArmCurve[];
  invariants: InvariantReport;
  spend: { totalUsd: number; meanPerMimicUsd: number; p95PerMimicUsd: number };
  configs: ConfigRecord[];
  experiments: ExperimentRecord[];
  /** The experiment the arm curves are restricted to; null = every mimic, grouped by arm. */
  armExperimentId: string | null;
  evalRuns: EvalRunRecord[];
}

/**
 * `/lab` (PLAN §10.1, §12). Research metrics only include `consent_research` mimics unless `includeAll` (for local
 * dev and ops) is set.
 */
export async function labOverview(
  deps: EngineDeps,
  opts: { includeAll?: boolean; experimentId?: string | null } = {},
): Promise<LabOverview> {
  const armExperimentId = opts.experimentId ?? null;
  const mimics = await deps.store.listMimics(opts.includeAll ? {} : { consentResearch: true });
  const rows: ScoredRow[] = [];
  const failures: Array<{ predictorId: string; role: string }> = [];
  const byArm = new Map<
    string,
    { final: number[]; spend: number[]; byK: Map<number, number[]>; toTarget: number[] }
  >();
  const inv: InvariantReport = {
    servedQuestions: 0,
    incomplete: 0,
    pending: 0,
    shadowStateMismatches: 0,
    nonContextBaselines: 0,
    sealingViolations: 0,
  };

  for (const m of mimics) {
    const [scored, preds, questions, fid, cfg] = await Promise.all([
      deps.store.listScoredPredictions(m.id, ['primary', 'baseline', 'shadow']),
      deps.store.listPredictions({ mimicId: m.id }),
      deps.store.listQuestions(m.id),
      deps.store.listFidelity(m.id),
      loadConfig(deps, m.configHash),
    ]);
    for (const r of scored) {
      rows.push({
        mimicId: m.id,
        questionId: r.question.id,
        predictorId: r.prediction.predictorId,
        role: r.prediction.role,
        itemAcc: r.score.itemAcc,
        top1: r.score.top1,
        logLoss: r.score.logLoss,
        brier: r.score.brier,
        confidence: r.prediction.dist[argmax(r.prediction.dist)] ?? 0,
        costUsd: r.prediction.costUsd,
        latencyMs: r.prediction.latencyMs,
      });
    }
    for (const p of preds) if (!p.ok) failures.push({ predictorId: p.predictorId, role: p.role });

    // Invariant monitor (PLAN §3; M5 acceptance).
    const predsByQ = new Map<string, typeof preds>();
    for (const p of preds) predsByQ.set(p.questionId, [...(predsByQ.get(p.questionId) ?? []), p]);
    for (const q of questions) {
      // Repeats and person-written feedback carry no predictions by design (PLAN §9.5; ADR-0027).
      if (q.seq === null || q.kind === 'repeat' || q.kind === 'feedback') continue;
      inv.servedQuestions++;
      const ps = predsByQ.get(q.id) ?? [];
      const primary = ps.find((p) => p.role === 'primary');
      const baseline = ps.find((p) => p.role === 'baseline');
      const shadows = ps.filter((p) => p.role === 'shadow');
      const expectShadows = q.kind === 'playground' ? 0 : cfg.predictor.shadows.length;
      if (!primary || !baseline || shadows.length < expectShadows) {
        if (q.servedAt !== null && deps.clock() - q.servedAt < PENDING_WINDOW_MS) inv.pending++;
        else inv.incomplete++;
      }
      if (primary)
        inv.shadowStateMismatches += shadows.filter((s) => s.stateHash !== primary.stateHash).length;
      if (baseline && baseline.evidenceSeqMax !== 0) inv.nonContextBaselines++;
      inv.sealingViolations += ps.filter((p) => p.evidenceSeqMax >= q.seq!).length;
    }

    if (armExperimentId && m.experimentId !== armExperimentId) continue;
    const arm = m.arm ?? 'default';
    const a = byArm.get(arm) ?? { final: [], spend: [], byK: new Map<number, number[]>(), toTarget: [] };
    a.spend.push(m.spendUsd);
    const k = questionsToSustain(
      fid.map((f) => f.fidelity),
      FIDELITY_TARGET,
    );
    if (k !== null) a.toTarget.push(k);
    // Fidelity after k answered questions: the k-th fidelity row.
    fid.forEach((f, i) => {
      const k = i + 1;
      a.byK.set(k, [...(a.byK.get(k) ?? []), f.fidelity]);
    });
    if (fid.length) a.final.push(fid.at(-1)!.fidelity);
    byArm.set(arm, a);
  }

  const arms: ArmCurve[] = [...byArm.entries()].map(([arm, a]) => ({
    arm,
    mimics: a.spend.length,
    points: [...a.byK.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([k, v]) => ({ k, fidelity: v.reduce((s, x) => s + x, 0) / v.length, n: v.length })),
    meanSpendUsd: a.spend.reduce((s, x) => s + x, 0) / (a.spend.length || 1),
    meanFinalFidelity: a.final.length ? a.final.reduce((s, x) => s + x, 0) / a.final.length : null,
    fidelityAt20: (() => {
      const v = a.byK.get(20);
      return v?.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    })(),
    questionsToTarget: a.toTarget.length ? quantile(a.toTarget, 0.5) : null,
    reachedTarget: a.toTarget.length,
  }));
  arms.sort((x, y) => x.arm.localeCompare(y.arm));

  const since = deps.clock() - 30 * 24 * 3600 * 1000;
  const mimicIds = new Set(mimics.map((m) => m.id));
  const calls = (await deps.store.listModelCalls({ since, limit: 100_000 })).filter(
    (c) => opts.includeAll || (c.mimicId !== null && mimicIds.has(c.mimicId)),
  );
  const spends = mimics.map((m) => m.spendUsd).sort((a, b) => a - b);
  const [configs, experiments, evalRuns] = await Promise.all([
    deps.store.listConfigs(),
    deps.store.listExperiments(),
    deps.store.listEvalRuns(),
  ]);
  return {
    scope: opts.includeAll ? 'all' : 'consented',
    mimics: mimics.length,
    predictors: predictorMetrics(rows, failures),
    calls: callMetrics(calls),
    arms,
    invariants: inv,
    spend: {
      totalUsd: spends.reduce((a, b) => a + b, 0),
      meanPerMimicUsd: spends.length ? spends.reduce((a, b) => a + b, 0) / spends.length : 0,
      p95PerMimicUsd: spends.length
        ? spends[Math.min(spends.length - 1, Math.floor(spends.length * 0.95))]!
        : 0,
    },
    configs,
    experiments,
    armExperimentId,
    evalRuns,
  };
}
