import { isTimeoutError, TRANSIENT_HTTP_STATUS } from '@mimic/core';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  /**
   * ADR-0002: local egress relay (e.g. http://127.0.0.1:8790). When set, `https://host/path` is requested as
   * `{relay}/host/path`; the relay forwards it through the environment's proxy, which injects credentials.
   */
  relay?: string;
  timeoutMs?: number;
  retries?: number;
  /**
   * Retry an attempt that timed out (default true). Chat turns it off: a timeout there means the model was too slow,
   * and a retry would bill a second generation and hide the slowness (ADR-0037).
   */
  retryTimeouts?: boolean;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export function relayUrl(url: string, relay?: string): string {
  if (!relay) return url;
  const u = new URL(url);
  return `${relay.replace(/\/+$/, '')}/${u.host}${u.pathname}${u.search}`;
}

/**
 * POST/GET JSON with timeout and bounded retries on transient statuses. Never logs headers. `latencyMs` is the
 * attempt that succeeded: earlier failed attempts and backoff are retry overhead, not the provider's response time.
 */
export async function requestJson(
  opts: HttpOptions,
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
): Promise<{ json: unknown; status: number; latencyMs: number; attempts: number }> {
  const f = opts.fetch ?? ((i, r) => fetch(i, r));
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await f(relayUrl(url, opts.relay), {
        method: init.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(res.status, text, url);
        if (TRANSIENT_HTTP_STATUS.has(res.status) && attempt < retries) {
          lastErr = err;
          await sleep(250 * 4 ** attempt);
          continue;
        }
        throw err;
      }
      return {
        json: text ? JSON.parse(text) : null,
        status: res.status,
        latencyMs: Date.now() - started,
        attempts: attempt + 1,
      };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (opts.retryTimeouts === false && isTimeoutError(e)) throw e;
      lastErr = e;
      if (attempt < retries) {
        await sleep(250 * 4 ** attempt);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Adds an auth header only when a key is configured (the dev proxy injects keys itself). */
export function authHeader(name: string, value: string | undefined, prefix = ''): Record<string, string> {
  return value ? { [name]: `${prefix}${value}` } : {};
}
