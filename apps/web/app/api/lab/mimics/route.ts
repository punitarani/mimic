import { LAB_PEOPLE_SORTS, labMimics, POPULATIONS } from '@mimic/core';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin';
import { deps, handle, ok } from '@/lib/server';

const Query = z.object({
  /** `all` (or none) is everyone, as on the page. */
  population: z.enum([...POPULATIONS, 'all']).optional(),
  consent: z.enum(['1', '0']).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(LAB_PEOPLE_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** GET /api/lab/mimics[?population=real&consent=1&q=…&sort=recent&limit=50&offset=0] — people and their mimics (ADR-0076). */
export const GET = handle(async (req: Request) => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  const { population, consent, q, ...p } = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return ok(
    await labMimics(d, {
      ...p,
      ...(population && population !== 'all' ? { population } : {}),
      ...(consent ? { consentResearch: consent === '1' } : {}),
      ...(q ? { query: q } : {}),
    }),
  );
});
