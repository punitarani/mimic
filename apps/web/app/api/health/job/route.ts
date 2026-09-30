import { deps, fail, handle, ok } from '@/lib/server';

/** Checks the jobs ledger, e.g. `?key=noop:<id>`, to confirm the worker consumed a job. */
export const GET = handle(async (req: Request) => {
  const key = new URL(req.url).searchParams.get('key');
  if (!key) return fail(400, 'key required');
  const { deps: d } = await deps();
  return ok({ job: await d.store.getJob(key) });
});
