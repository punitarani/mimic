import { requireAdmin } from '@/lib/admin';
import { deps, handle, ok } from '@/lib/server';

/** GET /api/lab/evals — eval runs written by the eval CLI (`mimic-eval report`). */
export const GET = handle(async () => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  return ok({ evalRuns: await d.store.listEvalRuns() });
});
