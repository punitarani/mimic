import {
  buildState,
  type Distribution,
  type EngineDeps,
  isPredictedKind,
  isScoredKind,
  loadConfig,
  loadMimicData,
  loadMimicDataAt,
  type MimicRecord,
  needsScores,
  type PersonState,
  type PredictionRole,
  type QuestionRecord,
  repeatAgreement,
  seededRng,
  shuffle,
  stateOptions,
} from '@mimic/core';
import { HELDOUT_PREFIX } from '../replay';

/** A stored online prediction for an instance's question (for `evaluate --from stored`). */
export interface StoredPrediction {
  predictorId: string;
  role: PredictionRole;
  /** A primary served by the LLM fallback because Jev failed (PLAN §16): not the configured primary's prediction. */
  fallback: boolean;
  dist: Distribution;
  ok: boolean;
  costUsd: number;
  latencyMs: number;
  modelSnapshot: string;
  stateHash: string;
}

/**
 * One sealed prediction task (docs/OPTIMIZATION.md §3.1): a question, the state built only from answers with
 * seq < its seq (and derived data as of its `stateAt`), and the person's answer. Candidates change how the state is
 * rendered and asked, never what it contains, so sealing (invariant 1) holds by construction.
 */
export interface EvalInstance {
  id: string;
  mimicId: string;
  split: 'dev' | 'test';
  mode: 'online' | 'heldout';
  questionId: string;
  seq: number;
  /** Heldout mode: number of evidence items in the state. */
  k?: number;
  question: QuestionRecord;
  answer: string;
  why: string | null;
  revealed: boolean;
  state: PersonState;
  /** Stored context-only baseline (Jev on intake + facts), when the question was served online. */
  baseline: Distribution | null;
  /** Agreement between this answer and a repeat probe of the same item, when one was asked. */
  repeatAgreement: number | null;
  stored: StoredPrediction[];
  /** Identity strings that must never appear in a candidate prompt (leakage lint). */
  identityTerms: string[];
}

export interface LoadOptions {
  /** Checkpoint for heldout (Twin-2K-500) people: states hold their first k wave 1–3 answers. */
  k: number;
  split: 'dev' | 'test' | 'all';
  limitPeople?: number;
  /** Cap on heldout targets per person, so a Twin person doesn't dominate. */
  maxTargetsPerPerson?: number;
  seed: string;
}

function identityTerms(m: MimicRecord, facts: Array<{ object: string; userState: string }>): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = (s ?? '').trim();
    if (t.length >= 4 && t !== 'Participant') out.add(t);
  };
  add(m.displayName);
  for (const part of (m.location ?? '').split(',')) add(part);
  add(m.employer);
  for (const f of facts) if (f.userState === 'active') add(f.object);
  return [...out];
}

/**
 * Loads evaluation instances from one data file (an export, or a Twin-2K-500 import). Consented mimics only
 * (invariant 7); each keeps its fixed `hash(mimicId)` split. People with Twin held-out items become heldout instances
 * at checkpoint k; everyone else contributes their served, answered anchor and adaptive questions.
 */
export async function loadInstances(deps: EngineDeps, opts: LoadOptions): Promise<EvalInstance[]> {
  const all = await deps.store.listMimics({ consentResearch: true });
  let mimics = all.filter((m) => opts.split === 'all' || m.split === opts.split);
  mimics = shuffle(mimics, seededRng(`people:${opts.seed}`)).slice(0, opts.limitPeople ?? mimics.length);
  const out: EvalInstance[] = [];
  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const loaded = await loadMimicData(deps, m);
    const answers = new Map(loaded.answers.map((a) => [a.questionId, a]));
    const idTerms = identityTerms(m, loaded.data.facts);
    const agreement = new Map<string, number>();
    for (const q of loaded.questions) {
      if (q.kind !== 'repeat' || !q.repeatOf) continue;
      const a1 = answers.get(q.repeatOf);
      const a2 = answers.get(q.id);
      if (a1 && a2) agreement.set(q.repeatOf, repeatAgreement(q.type, a1.value, a2.value));
    }
    const heldout = loaded.questions.some((q) => q.itemKey?.startsWith(HELDOUT_PREFIX));
    if (heldout) {
      const items = loaded.data.evidence.filter((e) => isScoredKind(e.kind)).sort((a, b) => a.seq - b.seq);
      const qById = new Map(loaded.questions.map((q) => [q.id, q]));
      const isHeld = (id: string) => qById.get(id)?.itemKey?.startsWith(HELDOUT_PREFIX) ?? false;
      const train = items.filter((e) => !isHeld(e.questionId)).slice(0, opts.k);
      if (train.length < opts.k) continue;
      const trainSeqs = new Set(train.map((e) => e.seq));
      const beforeSeq = train.at(-1)!.seq + 1;
      // Derived data as it stood when the next predicted question was served, sealed below it (ADR-0017), as in
      // replay: traits and insights computed from later answers (held-out targets included) must not reach the
      // state. Feedback takes seqs without a serve, so it never sets the as-of time (ADR-0032).
      const next = loaded.questions
        .filter((q) => q.seq !== null && q.seq >= beforeSeq && isPredictedKind(q.kind))
        .sort((a, b) => a.seq! - b.seq!)[0];
      const asOf = await loadMimicDataAt(
        deps,
        m,
        next?.stateAt ?? next?.servedAt ?? Number.MAX_SAFE_INTEGER,
        beforeSeq,
        { scores: needsScores(cfg) },
      );
      const state = buildState(
        {
          ...asOf.data,
          // Feedback given before the checkpoint stays in, as it did online (ADR-0032).
          evidence: asOf.data.evidence.filter(
            (e) => trainSeqs.has(e.seq) || (e.kind === 'feedback' && e.seq < beforeSeq),
          ),
        },
        stateOptions(cfg, beforeSeq),
      );
      let targets = items.filter((e) => isHeld(e.questionId));
      targets = shuffle(targets, seededRng(`targets:${opts.seed}:${m.id}`)).slice(
        0,
        opts.maxTargetsPerPerson ?? targets.length,
      );
      for (const e of targets) {
        const q = qById.get(e.questionId)!;
        const a = answers.get(q.id)!;
        out.push({
          id: `${m.id}:${q.id}@${opts.k}`,
          mimicId: m.id,
          split: m.split,
          mode: 'heldout',
          questionId: q.id,
          seq: q.seq!,
          k: opts.k,
          question: q,
          answer: a.value,
          why: a.why,
          revealed: a.revealedPrediction,
          state,
          baseline: null,
          repeatAgreement: agreement.get(q.id) ?? null,
          stored: [],
          identityTerms: idTerms,
        });
      }
      continue;
    }

    const preds = await deps.store.listPredictions({ mimicId: m.id });
    const byQ = new Map<string, StoredPrediction[]>();
    for (const p of preds) {
      const list = byQ.get(p.questionId) ?? [];
      list.push({
        predictorId: p.predictorId,
        role: p.role,
        fallback: p.fallback,
        dist: p.dist,
        ok: p.ok,
        costUsd: p.costUsd,
        latencyMs: p.latencyMs,
        modelSnapshot: p.modelSnapshot,
        stateHash: p.stateHash,
      });
      byQ.set(p.questionId, list);
    }
    const served = loaded.questions
      .filter((q) => isScoredKind(q.kind) && q.seq !== null && answers.has(q.id))
      .sort((a, b) => a.seq! - b.seq!);
    for (const q of served) {
      const a = answers.get(q.id)!;
      // The state as it was served (ADR-0017): evidence below seq, derived data as of the question's stateAt.
      const at = q.stateAt ?? q.servedAt ?? a.createdAt;
      const asOf = await loadMimicDataAt(deps, m, at, q.seq!, { scores: needsScores(cfg) });
      const state = buildState(asOf.data, stateOptions(cfg, q.seq!, { forQuestions: [q] }));
      if (state.meta.evidenceSeqMax >= q.seq!) throw new Error(`Sealing violated for ${q.id}`);
      const stored = byQ.get(q.id) ?? [];
      const base = stored.find((p) => p.role === 'baseline' && p.ok);
      out.push({
        id: `${m.id}:${q.id}`,
        mimicId: m.id,
        split: m.split,
        mode: 'online',
        questionId: q.id,
        seq: q.seq!,
        question: q,
        answer: a.value,
        why: a.why,
        revealed: a.revealedPrediction,
        state,
        baseline: base?.dist ?? null,
        repeatAgreement: agreement.get(q.id) ?? null,
        stored,
        identityTerms: idTerms,
      });
    }
  }
  return out;
}

/** A short, stable label for a person in reports (never the name or the raw ID). */
export function personLabel(mimicId: string): string {
  return `p_${mimicId.replace(/^m_/, '').slice(-6)}`;
}
