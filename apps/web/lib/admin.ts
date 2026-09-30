import 'server-only';
import { EngineError } from '@mimic/core';
import { isAdmin } from './server';

/** Lab routes sit behind Cloudflare Access plus ADMIN_EMAILS (PLAN §11). */
export async function requireAdmin(env: CloudflareEnv): Promise<void> {
  if (!(await isAdmin(env))) throw new EngineError('not_found', 'Not found');
}
