import {
  blockedFacetIds,
  type MimicScope,
  newlyDeclined,
  normalizeScope,
  questionAllowed,
  scopeShrank,
} from '../scope';
import type { MimicRecord } from '../store';
import { isSessionKind } from '../types';
import { type EngineDeps, EngineError, facetsFor, loadConfig, requireMimic } from './deps';

export interface ScopeChange {
  scope: MimicScope;
  scopeAt: number | null;
  /** Questions pooled or waiting to be answered that the new scope put out of reach. */
  discarded: number;
}

/**
 * Changes what a mimic may be asked about and learn (ADR-0040). The scope is normalised first (consents of deselected
 * categories are dropped). A request that omits `confirmed` or `declined` keeps the stored ones, so a client that
 * predates them can't clear them (ADR-0050).
 *
 * When something becomes blocked (a category, a consent or a confirmation removed, or a facet declined), every pooled
 * or served-but-unanswered session question touching a now-blocked facet is discarded so it is never served. When
 * that hides something already learned, `scopeAt` is stamped and the loaders hide it from then on: always for a
 * category, consent or confirmation removed (ADR-0040), and for a declined facet only when an answered question
 * touches it, so declining a question nobody has answered yet keeps every sealed state replayable. Growing the scope
 * changes no stored data: the pool fills with the new areas on the next refill.
 */
export async function setScope(deps: EngineDeps, mimicId: string, input: MimicScope): Promise<ScopeChange> {
  const m = await requireMimic(deps, mimicId);
  const scope = normalizeScope(
    {
      ...input,
      ...(input.confirmed === undefined && m.scope.confirmed ? { confirmed: m.scope.confirmed } : {}),
      ...(input.declined === undefined && m.scope.declined ? { declined: m.scope.declined } : {}),
    },
    m.consentResearch,
  );
  const now = deps.clock();
  const shrank = scopeShrank(m.scope, scope);
  const declined = new Set(newlyDeclined(m.scope, scope));
  let discarded = 0;
  let hidesAnswers = shrank;
  if (shrank || declined.size) {
    const questions = await deps.store.listQuestions(m.id);
    if (!hidesAnswers)
      hidesAnswers = questions.some(
        (q) => q.status === 'answered' && q.facetIds.some((f) => declined.has(f)),
      );
    const next: MimicRecord = { ...m, scope };
    const blocked = blockedFacetIds(
      scope,
      await facetsFor(deps, next, await loadConfig(deps, m.configHash), { scoped: false }),
    );
    for (const q of questions) {
      if (q.status !== 'pooled' && q.status !== 'served') continue;
      if (!isSessionKind(q.kind) || questionAllowed(q, blocked)) continue;
      await deps.store.updateQuestionStatus(q.id, 'discarded');
      discarded++;
    }
  }
  const scopeAt = hidesAnswers ? now : m.scopeAt;
  await deps.store.updateMimic(m.id, { scope, scopeAt, updatedAt: now });
  // Top the pool up from the new scope: widening adds areas, narrowing may have emptied it (ADR-0043).
  await deps.jobs.enqueue({ type: 'pool.refill', mimicId: m.id, seq: m.seqMax + 1 });
  return { scope, scopeAt, discarded };
}

/**
 * "Prefer not to say" on a served question (ADR-0050): its sensitive facets join the person's declined facets, so the
 * question is discarded unanswered, nothing is scored, and those facets are never asked about again (the person can
 * undo it in Topics and consent). Only a served question touching a sensitive facet can be declined; declining one
 * already declined changes nothing.
 */
export async function declineQuestion(
  deps: EngineDeps,
  mimicId: string,
  questionId: string,
): Promise<ScopeChange> {
  const m = await requireMimic(deps, mimicId);
  const q = await deps.store.getQuestion(questionId);
  if (!q || q.mimicId !== m.id) throw new EngineError('not_found', 'Question not found');
  const cfg = await loadConfig(deps, m.configHash);
  const sensitive = new Set(
    (await facetsFor(deps, m, cfg, { scoped: false })).filter((f) => f.sensitive).map((f) => f.id),
  );
  const facets = q.facetIds.filter((f) => sensitive.has(f));
  if (!facets.length)
    throw new EngineError('conflict', 'Only a question on a sensitive topic can be skipped');
  const already = new Set(m.scope.declined ?? []);
  if (facets.every((f) => already.has(f))) return { scope: m.scope, scopeAt: m.scopeAt, discarded: 0 };
  if (q.status !== 'served') throw new EngineError('conflict', 'Only the current question can be skipped');
  return setScope(deps, m.id, { ...m.scope, declined: [...already, ...facets] });
}
