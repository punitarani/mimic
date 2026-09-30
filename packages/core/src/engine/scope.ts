import { blockedFacetIds, type MimicScope, normalizeScope, questionAllowed, scopeShrank } from '../scope';
import type { MimicRecord } from '../store';
import { isSessionKind } from '../types';
import { type EngineDeps, facetsFor, loadConfig, requireMimic } from './deps';

export interface ScopeChange {
  scope: MimicScope;
  scopeAt: number | null;
  /** Questions pooled or waiting to be answered that the new scope put out of reach. */
  discarded: number;
}

/**
 * Changes what a mimic may be asked about and learn (ADR-0038). The scope is normalised first (consents of deselected
 * categories are dropped). When it shrinks, `scopeAt` is stamped, and every pooled or served-but-unanswered session
 * question touching a now-blocked facet is discarded so it is never served; what was learned from earlier answers in
 * that area is hidden from then on by the loaders. Growing the scope changes no stored data: the pool fills with the
 * new areas on the next refill.
 */
export async function setScope(deps: EngineDeps, mimicId: string, input: MimicScope): Promise<ScopeChange> {
  const m = await requireMimic(deps, mimicId);
  const scope = normalizeScope(input, m.consentResearch);
  const now = deps.clock();
  const shrank = scopeShrank(m.scope, scope);
  const scopeAt = shrank ? now : m.scopeAt;
  await deps.store.updateMimic(m.id, { scope, scopeAt, updatedAt: now });
  let discarded = 0;
  if (shrank) {
    const next: MimicRecord = { ...m, scope, scopeAt };
    const blocked = blockedFacetIds(
      scope,
      await facetsFor(deps, next, await loadConfig(deps, m.configHash), { scoped: false }),
    );
    for (const q of await deps.store.listQuestions(m.id, ['pooled', 'served'])) {
      if (!isSessionKind(q.kind) || questionAllowed(q, blocked)) continue;
      await deps.store.updateQuestionStatus(q.id, 'discarded');
      discarded++;
    }
  }
  return { scope, scopeAt, discarded };
}
