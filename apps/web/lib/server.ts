import 'server-only';
import { BudgetExceededError, type EngineDeps, EngineError, type MimicRecord, ulid } from '@mimic/core';
import { type MimicBindings, runtimeEngineDeps } from '@mimic/db/runtime';
import { getCloudflareContext, initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { cookies, headers } from 'next/headers';
import { after, NextResponse } from 'next/server';
import { z } from 'zod';

export const PID_COOKIE = 'mimic_pid';

const CONTEXT = Symbol.for('__cloudflare-context__');
const DEV_INIT = Symbol.for('mimic.dev-context-init');

/**
 * In `next dev`, bindings come from wrangler's getPlatformProxy. OpenNext's own fallback would persist to
 * apps/web/.wrangler; this makes every Next process use the state dir shared with the worker's `wrangler dev`,
 * and initializes it once per process.
 */
async function devContext(): Promise<void> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[CONTEXT]) return;
  g[DEV_INIT] ??= initOpenNextCloudflareForDev({ persist: { path: '../../.wrangler/state/v3' } });
  await g[DEV_INIT];
}

export async function env(): Promise<CloudflareEnv> {
  if (process.env.NODE_ENV === 'development') await devContext();
  return (await getCloudflareContext({ async: true })).env;
}

/**
 * Engine deps for one request. Deferred work runs after the response via Next's `after()` (waitUntil on Workers);
 * phase timings are collected for the Server-Timing header.
 */
export async function deps(): Promise<{ deps: EngineDeps; env: CloudflareEnv; serverTiming: () => string }> {
  const e = await env();
  const timings: Array<[string, number]> = [];
  const d = await runtimeEngineDeps(e as MimicBindings, {
    defer: (task) =>
      after(() =>
        task().catch((err: unknown) => {
          console.error('deferred task failed', err);
        }),
      ),
    timing: (phase, ms) => timings.push([phase, ms]),
  });
  return { deps: d, env: e, serverTiming: () => timings.map(([p, ms]) => `${p};dur=${ms}`).join(', ') };
}

// ---------------------------------------------------------------------------------------------------------------
// Participant identity: a signed, httpOnly cookie (PLAN §8.2). Nothing sensitive goes in localStorage.
// ---------------------------------------------------------------------------------------------------------------

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function secretOf(e: CloudflareEnv): string {
  if (!e.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');
  return e.SESSION_SECRET;
}

export async function signPid(e: CloudflareEnv, pid: string): Promise<string> {
  return `${pid}.${await hmac(secretOf(e), pid)}`;
}

export async function verifyPid(e: CloudflareEnv, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const pid = token.slice(0, i);
  const expected = await hmac(secretOf(e), pid);
  return timingSafeEqual(expected, token.slice(i + 1)) ? pid : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Returns the participant id, creating and setting the cookie if needed (route handlers only). */
export async function participant(e: CloudflareEnv): Promise<string> {
  const jar = await cookies();
  const existing = await verifyPid(e, jar.get(PID_COOKIE)?.value);
  if (existing) return existing;
  const pid = ulid();
  jar.set(PID_COOKIE, await signPid(e, pid), {
    httpOnly: true,
    sameSite: 'lax',
    secure: e.DEV_MODE !== '1',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return pid;
}

/** The participant id from the cookie, without creating one (server components). */
export async function currentParticipant(e: CloudflareEnv): Promise<string | null> {
  return verifyPid(e, (await cookies()).get(PID_COOKIE)?.value);
}

/**
 * Admin: behind Cloudflare Access in deployed envs (the Access-authenticated email header), checked against
 * ADMIN_EMAILS. In local dev (DEV_MODE=1) the lab is open.
 */
export async function isAdmin(e: CloudflareEnv): Promise<boolean> {
  if (e.DEV_MODE === '1') return true;
  const email = (await headers()).get('cf-access-authenticated-user-email')?.toLowerCase();
  const allowed = (e.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && allowed.includes(email);
}

export function inviteOk(e: CloudflareEnv, code: string | undefined): boolean {
  const codes = (e.INVITE_CODES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !!code && codes.includes(code.trim());
}

/** Per-participant and per-IP rate limits (PLAN §11). */
export async function rateLimited(e: CloudflareEnv, pid: string): Promise<boolean> {
  if (!e.RL) return false;
  const ip = (await headers()).get('cf-connecting-ip') ?? 'local';
  const [a, b] = await Promise.all([e.RL.limit({ key: `p:${pid}` }), e.RL.limit({ key: `ip:${ip}` })]);
  return !a.success || !b.success;
}

/** Loads a mimic and checks it belongs to the caller (self-only mimics, PLAN §15). */
export async function ownMimic(
  d: EngineDeps,
  e: CloudflareEnv,
  id: string,
): Promise<{ mimic: MimicRecord; pid: string }> {
  const pid = await participant(e);
  const m = await d.store.getMimic(id);
  if (!m || (m.participantId !== pid && !(await isAdmin(e))))
    throw new EngineError('not_found', 'Mimic not found');
  return { mimic: m, pid };
}

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

export function ok<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...(init?.headers ?? {}) },
  });
}

export function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

const STATUS: Record<EngineError['code'], number> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  forbidden: 403,
  budget: 402,
};

/** Wraps a route handler: zod and engine errors become typed JSON errors; nothing internal leaks. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof EngineError) return fail(STATUS[e.code], e.message);
      if (e instanceof BudgetExceededError) return fail(402, 'This mimic reached its spending cap.');
      if (e instanceof z.ZodError)
        return fail(400, e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      console.error(e);
      return fail(500, 'Something went wrong.');
    }
  };
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new EngineError('invalid', 'Invalid JSON body');
  }
  return schema.parse(raw);
}

export type RouteCtx<P extends Record<string, string>> = { params: Promise<P> };
