import { labOverview } from '@mimic/core';
import { requireAdmin } from '@/lib/admin';
import { deps, handle, ok } from '@/lib/server';

/** GET /api/lab/metrics[?all=1] — predictor metrics, cost/latency, arm curves and invariant checks. */
export const GET = handle(async (req: Request) => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  return ok(await labOverview(d, { includeAll: new URL(req.url).searchParams.get('all') === '1' }));
});
