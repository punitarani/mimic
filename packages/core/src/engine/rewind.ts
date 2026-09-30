import { z } from 'zod';
import { jobKey } from '../jobs';
import type { AnswerRewindRecord, DerivedRollback, FactRecord, MimicRecord } from '../store';
import { vectorId } from './data';
import { type EngineDeps, EngineError, loadConfig, requireMimic } from './deps';
import {
  copyQuestionVectors,
  type Progress,
  type PublicQuestion,
  poolCopies,
  progressOf,
  requeueDiscarded,
  toPublic,
} from './session';

/**
 * Undo the latest answer (ADR-0027). The person names the question they are taking back, so a double click or a
 * stale tab can't undo an answer they didn't mean to.
 */
export const RewindInput = z.object({ questionId: z.string().min(1).max(100) });
export type RewindInput = z.infer<typeof RewindInput>;

export interface RewindResult {
  /** The question again, still sealed on the answers before it. */
  question: PublicQuestion;
  progress: Progress;
  /** What was taken back, so the client can say so and put the reason back in the field. */
  previous: { value: string; why: string | null };
}

/** Evidence seqs a reflection fact cites (`sourceRef = answers:3,7`). */
export function citedSeqs(sourceRef: string | null): number[] {
  if (!sourceRef?.startsWith('answers:')) return [];
  return sourceRef
    .slice('answers:'.length)
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

/**
 * What a retraction at `fromSeq` invalidates. Traits, insights and fidelity are selected by seq in the store; facts
 * go when they cite the retracted evidence. The per-seq jobs are cleared so the re-answer's can run again.
 */
export function derivedRollback(mimicId: string, fromSeq: number, facts: FactRecord[]): DerivedRollback {
  return {
    mimicId,
    fromSeq,
    factIds: facts
      .filter((f) => f.source === 'reflection' && citedSeqs(f.sourceRef).some((s) => s >= fromSeq))
      .map((f) => f.id),
    jobKeys: [
      jobKey({ type: 'snapshot.write', mimicId, seqUpTo: fromSeq }),
      jobKey({ type: 'hypotheses.refresh', mimicId, seqUpTo: fromSeq }),
    ],
  };
}

/** Index entries built from retracted evidence. Best effort: they are rebuildable, and missing ones fall back. */
async function dropIndexes(deps: EngineDeps, m: MimicRecord, fromSeq: number, factIds: string[]) {
  await deps.vectors
    .deleteByIds([vectorId.qa(m.id, fromSeq), ...factIds.map((id) => vectorId.fact(m.id, id))])
    .catch(() => {});
  try {
    const raw = await deps.kv.get(`hyp:${m.id}`);
    if (raw && (JSON.parse(raw) as { seqUpTo?: number }).seqUpTo! >= fromSeq)
      await deps.kv.delete(`hyp:${m.id}`);
  } catch {
    // Hypotheses are refreshed on the next reflection.
  }
}

/**
 * `POST /rewind`: takes back the latest answer so the person can answer that question again.
 *
 * - The answer moves to `answer_rewinds`; its scores and the fidelity rows from its seq on are deleted.
 * - The question goes back to `served` with the same seq and the same sealed predictions: they were built from
 *   answers before it (PLAN §3.1), so they still are.
 * - A question served after it (the prefetched next one) was predicted from a state that held the retracted answer.
 *   It is discarded with its predictions, and a fresh copy goes back in the pool (a repeat probe is just dropped).
 * - Derived state built from the answer is rolled back, so the re-answer is learned from scratch (PLAN §3.3).
 */
export async function rewindLastAnswer(
  deps: EngineDeps,
  mimicId: string,
  input: RewindInput,
): Promise<RewindResult> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (m.status !== 'learning') throw new EngineError('conflict', 'This session is not taking answers');
  const [questions, answers, facts, rewinds] = await Promise.all([
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listFacts(m.id),
    deps.store.listAnswerRewinds(m.id),
  ]);
  const qById = new Map(questions.map((q) => [q.id, q]));
  const latest = answers.filter((a) => qById.get(a.questionId)?.kind !== 'playground').at(-1);
  if (!latest || latest.questionId !== input.questionId) {
    throw new EngineError('conflict', 'Only your latest answer can be undone');
  }
  const q = qById.get(latest.questionId)!;
  const later = questions.filter((x) => x.seq !== null && x.seq > latest.seq);
  if (later.some((x) => x.kind === 'playground')) {
    throw new EngineError(
      'conflict',
      "You've asked your mimic a question since, so this answer can't be undone",
    );
  }
  if (later.some((x) => x.status !== 'served'))
    throw new EngineError('conflict', 'A later question was answered');
  // One step only: while an undone question waits for its new answer, the one before it stays.
  const undone = new Set(rewinds.map((r) => r.questionId));
  if (later.some((x) => undone.has(x.id))) {
    throw new EngineError('conflict', 'Only your latest answer can be undone');
  }

  const now = deps.clock();
  const copies = poolCopies(deps, later);
  const rewind: AnswerRewindRecord = {
    id: deps.newId(),
    mimicId: m.id,
    questionId: q.id,
    seq: latest.seq,
    answerId: latest.id,
    value: latest.value,
    why: latest.why,
    latencyMs: latest.latencyMs,
    revealedPrediction: latest.revealedPrediction,
    idempotencyKey: latest.idempotencyKey,
    answeredAt: latest.createdAt,
    rewoundAt: now,
  };
  const derived = derivedRollback(m.id, latest.seq, facts);
  const discarded = await deps.store.rewindAnswer({ rewind, requeue: copies.map((c) => c.copy), derived });
  if (!discarded) throw new EngineError('conflict', 'That answer was already undone');

  await dropIndexes(deps, m, latest.seq, derived.factIds);
  await copyQuestionVectors(deps, m.id, copies);
  // A serve that committed between the read above and the rewind was discarded without a copy.
  const known = new Set(later.map((x) => x.id));
  await requeueDiscarded(
    deps,
    m.id,
    discarded.filter((x) => !known.has(x)),
  );

  const after = questions.map((x) => (x.id === q.id ? { ...x, status: 'served' as const } : x));
  return {
    question: toPublic({ ...q, status: 'served' }),
    progress: progressOf(after, cfg),
    previous: { value: latest.value, why: latest.why },
  };
}

/**
 * Undoes a learn job's writes when its answer was retracted while it ran (ADR-0027). If the question has been
 * answered again meanwhile, that answer's learn job is queued again, since the rollback may have removed its work.
 */
export async function rollbackStaleLearn(deps: EngineDeps, m: MimicRecord, seq: number): Promise<void> {
  const [facts, answers] = await Promise.all([deps.store.listFacts(m.id), deps.store.listAnswers(m.id)]);
  const derived = derivedRollback(m.id, seq, facts);
  const current = answers.find((a) => a.seq === seq);
  const relearn = current
    ? ({ type: 'learn.answer', mimicId: m.id, seq, answerId: current.id } as const)
    : null;
  if (relearn) derived.jobKeys.push(jobKey(relearn));
  await deps.store.rollbackDerived(derived);
  await dropIndexes(deps, m, seq, derived.factIds);
  if (relearn) await deps.jobs.enqueue(relearn);
}
