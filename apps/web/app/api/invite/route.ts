import { inviteRequired, type MimicBindings } from '@mimic/db/runtime';
import { env, handle, ok } from '@/lib/server';

/**
 * GET /api/invite — whether creating a mimic needs an invite code (`use-invite-code`, ADR-0054). `/new` is
 * prerendered, so the intake form asks here rather than having it baked into its HTML.
 */
export const GET = handle(async () => ok({ required: await inviteRequired((await env()) as MimicBindings) }));
