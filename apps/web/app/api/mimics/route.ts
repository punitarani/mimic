import { createMimic, IntakeInput, withResearchUse } from '@mimic/core';
import { inviteRequired, type MimicBindings } from '@mimic/db/runtime';
import { z } from 'zod';
import { body, deps, fail, handle, inviteOk, ok, participant, rateLimited } from '@/lib/server';

const CreateBody = IntakeInput.extend({ inviteCode: z.string().trim().max(100).optional() });

/**
 * POST /api/mimics — intake → { mimicId }. Enqueues identity.search only if the person consented. The invite code is
 * checked only while `use-invite-code` is on (ADR-0055); off, any code sent is ignored. Research consent covers the
 * sensitive areas the person left on (ADR-0065).
 */
export const POST = handle(async (req: Request) => {
  const { deps: d, env } = await deps();
  const pid = await participant(env);
  if (await rateLimited(env, pid)) return fail(429, 'Too many requests. Try again in a minute.');
  const [input, required] = await Promise.all([body(req, CreateBody), inviteRequired(env as MimicBindings)]);
  if (required && !inviteOk(env, input.inviteCode)) return fail(403, 'That invite code is not valid.');
  const { inviteCode: _code, ...intake } = input;
  const m = await createMimic(
    d,
    { ...intake, ...(intake.scope ? { scope: withResearchUse(intake.scope, null) } : {}) },
    pid,
  );
  return ok({ mimicId: m.id, identity: m.consentSearch }, { status: 201 });
});

/** GET /api/mimics — the caller's own mimics. */
export const GET = handle(async () => {
  const { deps: d, env } = await deps();
  const pid = await participant(env);
  const mimics = await d.store.listMimics({ participantId: pid });
  return ok({
    mimics: mimics.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      status: m.status,
      identityState: m.identityState,
      createdAt: m.createdAt,
    })),
  });
});
