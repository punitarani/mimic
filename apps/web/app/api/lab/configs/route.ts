import { configHash, PipelineConfig, registerConfig } from '@mimic/core';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin';
import { body, deps, handle, ok } from '@/lib/server';

/** GET /api/lab/configs — all configs (immutable, by hash). */
export const GET = handle(async () => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  return ok({ configs: await d.store.listConfigs() });
});

const Create = z.object({ label: z.string().min(1).max(80), config: PipelineConfig });

/** POST /api/lab/configs — register a config; a change always means a new hash. */
export const POST = handle(async (req: Request) => {
  const { deps: d, env } = await deps();
  await requireAdmin(env);
  const { label, config } = await body(req, Create);
  const hash = await registerConfig(d, config, label);
  return ok({ hash, same: hash === configHash(config) }, { status: 201 });
});
