import { argmax } from '../distribution';
import {
  type CallMetrics,
  callMetrics,
  type PredictorMetrics,
  predictorMetrics,
  type ScoredRow,
} from '../metrics';
import { type Population, populationOf } from '../participants';
import type { FidelityRecord, IdentityState, MimicRecord, MimicStatus, QuestionStatus } from '../store';
import type { Domain, Option, QKind, QType } from '../types';
import { loadMimicData } from './data';
import { type EngineDeps, requireMimic } from './deps';

/** One mimic in the `/lab/mimics` directory (ADR-0076). */
export interface LabMimicRow {
  id: string;
  participantId: string;
  population: Population;
  displayName: string;
  occupation: string | null;
  location: string;
  status: MimicStatus;
  identityState: IdentityState;
  consentResearch: boolean;
  configHash: string;
  configLabel: string | null;
  experimentId: string | null;
  arm: string | null;
  /** Answers given, feedback included (not `seqMax`, which also counts the question being asked). */
  answers: number;
  /** Latest fidelity row's value, accuracy and baseline accuracy; null before the first scored answer. */
  fidelity: number | null;
  accuracy: number | null;
  baselineAccuracy: number | null;
  /** Every fidelity row's value in seq order, for a sparkline. */
  fidelityCurve: number[];
  spendUsd: number;
  createdAt: number;
  updatedAt: number;
}

/** One person: a participant and the mimics they own, latest activity first. */
export interface LabPerson {
  participantId: string;
  population: Population;
  /** The mimics matching the filter. */
  mimics: LabMimicRow[];
  /** Every mimic the person owns, filtered out or not: what deleting the person removes. */
  ownedMimics: number;
  answers: number;
  spendUsd: number;
  createdAt: number;
  lastActiveAt: number;
}

export const LAB_PEOPLE_SORTS = ['recent', 'created', 'answers', 'spend'] as const;
export type LabPeopleSort = (typeof LAB_PEOPLE_SORTS)[number];

export interface LabMimicsFilter {
  /** Restrict to one population; omit for everyone (scripted and imported people stay labelled). */
  population?: Population;
  consentResearch?: boolean;
  /** Case-insensitive match on name, occupation, location, mimic ID or participant ID. */
  query?: string;
  sort?: LabPeopleSort;
  /** Paging over people (default 50 from 0); only the page's mimics read their fidelity rows. */
  limit?: number;
  offset?: number;
}

export interface LabMimics {
  people: LabPerson[];
  /** People and mimics matching the filter, before paging. */
  totalPeople: number;
  totalMimics: number;
  /** Mimics per population under the consent filter alone, for the filter chips. */
  counts: Record<Population | 'all', number>;
}

export function mimicRow(
  m: MimicRecord,
  fid: FidelityRecord[],
  configLabels: ReadonlyMap<string, string | null>,
  answers: number,
): LabMimicRow {
  const last = fid.at(-1);
  return {
    id: m.id,
    participantId: m.participantId,
    population: populationOf(m.participantId),
    displayName: m.displayName,
    occupation: m.occupation,
    location: m.location,
    status: m.status,
    identityState: m.identityState,
    consentResearch: m.consentResearch,
    configHash: m.configHash,
    configLabel: configLabels.get(m.configHash) ?? null,
    experimentId: m.experimentId,
    arm: m.arm,
    answers,
    fidelity: last?.fidelity ?? null,
    accuracy: last?.acc ?? null,
    baselineAccuracy: last?.accBaseline ?? null,
    fidelityCurve: fid.map((f) => f.fidelity),
    spendUsd: m.spendUsd,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/**
 * `/lab/mimics` (ADR-0076): every person and their mimics, for ops. Unlike `/lab`'s research numbers this lists
 * everyone, consented or not; each row says whether the person consented to research use and who they are
 * (`populationOf`).
 */
export async function labMimics(deps: EngineDeps, filter: LabMimicsFilter = {}): Promise<LabMimics> {
  const [everyone, configs] = await Promise.all([deps.store.listMimics({}), deps.store.listConfigs()]);
  // Owned counts ignore every filter: deleting a person removes all their mimics, shown or not.
  const owned = new Map<string, number>();
  for (const m of everyone) owned.set(m.participantId, (owned.get(m.participantId) ?? 0) + 1);
  const all =
    filter.consentResearch === undefined
      ? everyone
      : everyone.filter((m) => m.consentResearch === filter.consentResearch);
  const counts: Record<Population | 'all', number> = { all: all.length, real: 0, scripted: 0, twin2k: 0 };
  for (const m of all) counts[populationOf(m.participantId)]++;
  const q = filter.query?.trim().toLowerCase();
  const mimics = all.filter(
    (m) =>
      (!filter.population || populationOf(m.participantId) === filter.population) &&
      (!q ||
        [m.displayName, m.occupation ?? '', m.location, m.id, m.participantId].some((s) =>
          s.toLowerCase().includes(q),
        )),
  );
  const byPerson = new Map<string, MimicRecord[]>();
  for (const m of mimics) {
    const ms = byPerson.get(m.participantId);
    if (ms) ms.push(m);
    else byPerson.set(m.participantId, [m]);
  }
  const sort = filter.sort ?? 'recent';
  // Ranking by answers counts every candidate's answers; otherwise only the page's mimics are counted.
  const rankCounts = sort === 'answers' ? await deps.store.countAnswers(mimics.map((m) => m.id)) : null;
  const key = (ms: MimicRecord[]): number => {
    switch (sort) {
      case 'created':
        return Math.min(...ms.map((m) => m.createdAt));
      case 'answers':
        return ms.reduce((s, m) => s + (rankCounts?.get(m.id) ?? 0), 0);
      case 'spend':
        return ms.reduce((s, m) => s + m.spendUsd, 0);
      case 'recent':
        return Math.max(...ms.map((m) => m.updatedAt));
    }
  };
  const ranked = [...byPerson.entries()]
    .map(([participantId, ms]) => ({ participantId, ms, key: key(ms) }))
    .sort((a, b) => b.key - a.key || a.participantId.localeCompare(b.participantId));
  const offset = Math.max(0, filter.offset ?? 0);
  const page = ranked.slice(offset, offset + Math.max(1, filter.limit ?? 50));

  const pageIds = page.flatMap((p) => p.ms.map((m) => m.id));
  const [fidelityRows, answerCounts] = await Promise.all([
    deps.store.listFidelityFor(pageIds),
    rankCounts ?? deps.store.countAnswers(pageIds),
  ]);
  const fidelity = new Map<string, FidelityRecord[]>();
  for (const f of fidelityRows) {
    const fs = fidelity.get(f.mimicId);
    if (fs) fs.push(f);
    else fidelity.set(f.mimicId, [f]);
  }
  const labels = new Map(configs.map((c) => [c.hash, c.label]));
  const people: LabPerson[] = page.map(({ participantId, ms }) => {
    const rows = ms.map((m) => mimicRow(m, fidelity.get(m.id) ?? [], labels, answerCounts.get(m.id) ?? 0));
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      participantId,
      population: populationOf(participantId),
      mimics: rows,
      ownedMimics: owned.get(participantId) ?? rows.length,
      answers: rows.reduce((s, r) => s + r.answers, 0),
      spendUsd: rows.reduce((s, r) => s + r.spendUsd, 0),
      createdAt: Math.min(...rows.map((r) => r.createdAt)),
      lastActiveAt: Math.max(...rows.map((r) => r.updatedAt)),
    };
  });
  return { people, totalPeople: ranked.length, totalMimics: mimics.length, counts };
}

export interface LabQuestionRow {
  id: string;
  seq: number;
  kind: QKind;
  type: QType;
  domain: Domain;
  status: QuestionStatus;
  servedAt: number | null;
  /**
   * The person's scope hides this question: its prompt, facets, options, answer and the guesses' option keys and labels
   * are withheld here too (ADR-0040).
   */
  hidden: boolean;
  prompt: string | null;
  facetIds: string[];
  options: Option[];
  answer: { key: string; label: string; why: string | null; latencyMs: number } | null;
  primary: {
    predictorId: string;
    key: string;
    label: string;
    p: number;
    ok: boolean;
    fallback: boolean;
    itemAcc: number | null;
    latencyMs: number;
  } | null;
  baseline: { key: string; label: string; p: number; itemAcc: number | null } | null;
  shadows: number;
}

export interface AccuracyCurve {
  predictorId: string;
  role: string;
  /** Item accuracy per scored question in seq order, its running mean, and its mean over the last ROLLING_WINDOW. */
  points: Array<{ seq: number; itemAcc: number; cumulative: number; rolling: number }>;
}

export const ROLLING_WINDOW = 10;

export interface LabMimicDetail {
  mimic: LabMimicRow;
  experimentName: string | null;
  fidelity: FidelityRecord[];
  predictors: PredictorMetrics[];
  curves: AccuracyCurve[];
  questions: LabQuestionRow[];
  calls: CallMetrics[];
  /** The person's other mimics. */
  siblings: Array<Pick<LabMimicRow, 'id' | 'displayName' | 'status' | 'answers' | 'createdAt'>>;
}

/** Running and rolling item accuracy per predictor and role, over the question seq. */
export function accuracyCurves(rows: ScoredRow[], seqOf: ReadonlyMap<string, number>): AccuracyCurve[] {
  const groups = new Map<string, ScoredRow[]>();
  for (const r of rows) {
    if (!seqOf.has(r.questionId)) continue;
    const key = `${r.predictorId}|${r.role}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, g]) => {
    const [predictorId, role] = key.split('|') as [string, string];
    const sorted = g.sort((a, b) => seqOf.get(a.questionId)! - seqOf.get(b.questionId)!);
    let sum = 0;
    return {
      predictorId,
      role,
      points: sorted.map((r, i) => {
        sum += r.itemAcc;
        const win = sorted.slice(Math.max(0, i + 1 - ROLLING_WINDOW), i + 1);
        return {
          seq: seqOf.get(r.questionId)!,
          itemAcc: r.itemAcc,
          cumulative: sum / (i + 1),
          rolling: win.reduce((s, w) => s + w.itemAcc, 0) / win.length,
        };
      }),
    };
  });
}

const ROLE_ORDER: Record<string, number> = { primary: 0, baseline: 1, shadow: 2, hypothesis: 3 };

/** `/lab/mimics/[id]` (ADR-0076): one mimic's questions, answers, predictions, accuracy over time and cost. */
export async function labMimic(deps: EngineDeps, mimicId: string): Promise<LabMimicDetail> {
  const m = await requireMimic(deps, mimicId);
  const [loaded, fid, scored, preds, calls, configs, experiments, siblings] = await Promise.all([
    loadMimicData(deps, m),
    deps.store.listFidelity(m.id),
    deps.store.listScoredPredictions(m.id, ['primary', 'baseline', 'shadow']),
    deps.store.listPredictions({ mimicId: m.id }),
    deps.store.listModelCalls({ mimicId: m.id, limit: 100_000 }),
    deps.store.listConfigs(),
    deps.store.listExperiments(),
    deps.store.listMimics({ participantId: m.participantId }).then(async (ms) => {
      const others = ms.filter((s) => s.id !== m.id);
      return { others, answers: await deps.store.countAnswers(others.map((s) => s.id)) };
    }),
  ]);

  const rows: ScoredRow[] = scored.map((r) => ({
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
  }));
  const failures = preds.filter((p) => !p.ok).map((p) => ({ predictorId: p.predictorId, role: p.role }));
  // Ordered by role, then predictor.
  const predictors = predictorMetrics(rows, failures);

  const served = loaded.questions
    .filter((q): q is typeof q & { seq: number } => q.seq !== null)
    .sort((a, b) => a.seq - b.seq);
  const seqOf = new Map(served.map((q) => [q.id, q.seq]));
  const curves = accuracyCurves(rows, seqOf).sort(
    (a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.predictorId.localeCompare(b.predictorId),
  );

  const answers = new Map(loaded.answers.map((a) => [a.questionId, a]));
  const itemAcc = new Map(scored.map((r) => [r.prediction.id, r.score.itemAcc]));
  const predsByQ = new Map<string, typeof preds>();
  for (const p of preds) {
    const ps = predsByQ.get(p.questionId);
    if (ps) ps.push(p);
    else predsByQ.set(p.questionId, [p]);
  }
  const questions: LabQuestionRow[] = served.map((q) => {
    const hidden = loaded.scope.hiddenQuestionIds.has(q.id);
    const label = (key: string) => q.options.find((o) => o.key === key)?.label ?? key;
    const a = answers.get(q.id);
    const ps = predsByQ.get(q.id) ?? [];
    const top = (role: 'primary' | 'baseline') => {
      const p = ps.find((x) => x.role === role);
      if (!p) return null;
      const key = argmax(p.dist) ?? '';
      // A hidden question's option keys can name the answer as plainly as its labels: withhold both.
      return { p, key: hidden ? '' : key, label: hidden ? '' : label(key), prob: p.dist[key] ?? 0 };
    };
    const primary = top('primary');
    const baseline = top('baseline');
    return {
      id: q.id,
      seq: q.seq,
      kind: q.kind,
      type: q.type,
      domain: q.domain,
      status: q.status,
      servedAt: q.servedAt,
      hidden,
      prompt: hidden ? null : q.prompt,
      facetIds: hidden ? [] : q.facetIds,
      options: hidden ? [] : q.options,
      answer:
        a && !hidden ? { key: a.value, label: label(a.value), why: a.why, latencyMs: a.latencyMs } : null,
      primary: primary && {
        predictorId: primary.p.predictorId,
        key: primary.key,
        label: primary.label,
        p: primary.prob,
        ok: primary.p.ok,
        fallback: primary.p.fallback,
        itemAcc: itemAcc.get(primary.p.id) ?? null,
        latencyMs: primary.p.latencyMs,
      },
      baseline: baseline && {
        key: baseline.key,
        label: baseline.label,
        p: baseline.prob,
        itemAcc: itemAcc.get(baseline.p.id) ?? null,
      },
      shadows: ps.filter((p) => p.role === 'shadow').length,
    };
  });

  const labels = new Map(configs.map((c) => [c.hash, c.label]));
  return {
    mimic: mimicRow(m, fid, labels, loaded.answers.length),
    experimentName: experiments.find((e) => e.id === m.experimentId)?.name ?? null,
    fidelity: fid,
    predictors,
    curves,
    questions,
    calls: callMetrics(calls),
    siblings: siblings.others.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      status: s.status,
      answers: siblings.answers.get(s.id) ?? 0,
      createdAt: s.createdAt,
    })),
  };
}
