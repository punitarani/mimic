import { z } from 'zod';
import { blockedFacetIds, questionAllowed } from '../scope';
import type { AnswerRewindRecord, DerivedRollback, FactRecord, MimicRecord } from '../store';
import { isSessionKind } from '../types';
import { loadMimicData, qaText, vectorId } from './data';
import { ctxFor, type EngineDeps, EngineError, facetsFor, loadConfig, requireMimic } from './deps';
import {
  copyQuestionVectors,
  loadHypotheses,
  type Progress,
  type PublicQuestion,
  poolCopies,
  progressOf,
  requeueDiscarded,
  toPublic,
} from './session';

/**
 * Undo the latest answer (ADR-0036). The person names the question they are taking back, so a double click or a
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
 * What a retraction at `fromSeq` invalidates, beyond what the store selects by seq (traits, insights, reflection
 * facts by `seq_up_to`, persona drafts, fidelity): reflection facts written before `seq_up_to` existed, found by the
 * evidence they cite.
 */
export function derivedRollback(mimicId: string, fromSeq: number, facts: FactRecord[]): DerivedRollback {
  return {
    mimicId,
    fromSeq,
    factIds: facts
      .filter(
        (f) =>
          f.source === 'reflection' &&
          (f.seqUpTo ?? null) === null &&
          citedSeqs(f.sourceRef).some((s) => s >= fromSeq),
      )
      .map((f) => f.id),
  };
}

/**
 * Index entries built from retracted evidence: the Q&A vector at `fromSeq`, removed facts' vectors and hypotheses
 * from `fromSeq` on. Best effort: they are rebuildable, and missing ones fall back.
 */
async function dropIndexes(deps: EngineDeps, mimicId: string, fromSeq: number, factIds: string[]) {
  await deps.vectors
    .deleteByIds([vectorId.qa(mimicId, fromSeq), ...factIds.map((id) => vectorId.fact(mimicId, id))])
    .catch(() => {});
  const hyp = await loadHypotheses(deps, mimicId);
  if (hyp && hyp.seqUpTo >= fromSeq) await deps.kv.delete(`hyp:${mimicId}`).catch(() => {});
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
  const kindOf = (a: { questionId: string }) => qById.get(a.questionId)?.kind;
  const latest = answers
    .filter((a) => {
      const k = kindOf(a);
      return k !== undefined && isSessionKind(k);
    })
    .at(-1);
  if (!latest || latest.questionId !== input.questionId) {
    throw new EngineError('conflict', 'Only your latest answer can be undone');
  }
  const q = qById.get(latest.questionId)!;
  // A topic turned off since (ADR-0038): the question is hidden and must not be asked again.
  const blocked = blockedFacetIds(m.scope, await facetsFor(deps, m, cfg, { scoped: false }));
  if (!questionAllowed(q, blocked)) {
    throw new EngineError('conflict', "You've turned this topic off since, so this answer can't be undone");
  }
  const later = questions.filter((x) => x.seq !== null && x.seq > latest.seq);
  // Asked or taught on the mimic page since (ADR-0032): that prediction or learning used this answer.
  if (later.some((x) => !isSessionKind(x.kind))) {
    throw new EngineError(
      'conflict',
      "You've asked or taught your mimic something since, so this answer can't be undone",
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
  const done = await deps.store.rewindAnswer({ rewind, requeue: copies.map((c) => c.copy), derived });
  // The batch re-checks everything above atomically: the answer may have been undone, or something answered, asked
  // or taught after it, since the read.
  if (!done) throw new EngineError('conflict', 'Only your latest answer can be undone');

  await dropIndexes(deps, m.id, latest.seq, done.factIds);
  await copyQuestionVectors(deps, m.id, copies);
  // A serve that committed between the read above and the rewind was discarded without a copy.
  const known = new Set(later.map((x) => x.id));
  await requeueDiscarded(
    deps,
    m.id,
    done.discarded.filter((x) => !known.has(x)),
  );

  const after = questions.map((x) => (x.id === q.id ? { ...x, status: 'served' as const } : x));
  return {
    question: toPublic({ ...q, status: 'served' }),
    progress: progressOf(after, cfg),
    previous: { value: latest.value, why: latest.why },
  };
}

/**
 * Makes the Q&A vector at `seq` match the answer there now (ADR-0036): a learn job that embedded an answer undone
 * while it ran may have written it after the undo removed it. Deletes it if the question has no answer yet.
 */
export async function refreshQaVector(deps: EngineDeps, m: MimicRecord, seq: number): Promise<void> {
  try {
    const loaded = await loadMimicData(deps, m);
    const item = loaded.data.evidence.find((e) => e.seq === seq);
    if (!item) {
      await deps.vectors.deleteByIds([vectorId.qa(m.id, seq)]);
      return;
    }
    const emb = await deps.gateway.embed(ctxFor(m, 'embed.qa'), [qaText(item)]);
    await deps.vectors.upsert([
      {
        id: vectorId.qa(m.id, seq),
        values: emb.vectors[0]!,
        metadata: { mimicId: m.id, kind: 'qa', facetIds: item.facetIds.join(','), seq },
      },
    ]);
  } catch {
    // Index only; retrieval falls back without it.
  }
}
