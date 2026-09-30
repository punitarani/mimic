/**
 * ADR-0014: in local dev, `next dev` (getPlatformProxy) and `wrangler dev` (the worker) open the same SQLite file
 * from two processes, so a statement can fail with SQLITE_BUSY. Deployed D1 never reports that. This wrapper retries
 * only on lock errors; a failed statement or batch is rolled back, so a retry is safe.
 */
const RAW = Symbol('raw-d1-statement');
const BUSY = /SQLITE_BUSY|database is locked/i;
/** Through getPlatformProxy, a lock surfaces as an opaque "internal error"; only retried in local dev. */
const LOCAL_INTERNAL = /internal error; reference|SQLITE_BUSY/i;
const ATTEMPTS = 10;

function message(e: unknown): string {
  if (!e) return '';
  if (e instanceof Error) return `${e.message} ${message((e as { cause?: unknown }).cause)}`;
  return String(e);
}

export function retryer(local: boolean) {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = message(e);
        const retryable = BUSY.test(msg) || (local && LOCAL_INTERNAL.test(msg));
        if (!retryable || i >= ATTEMPTS - 1) throw e;
        await new Promise((r) => setTimeout(r, 15 * 2 ** i + Math.random() * 25));
      }
    }
  };
}

type Stmt = D1PreparedStatement & { [RAW]?: D1PreparedStatement };

function wrapStatement(s: D1PreparedStatement, retry: ReturnType<typeof retryer>): D1PreparedStatement {
  return new Proxy(s, {
    get(target, prop) {
      if (prop === RAW) return target;
      if (prop === 'bind') return (...args: unknown[]) => wrapStatement(target.bind(...args), retry);
      if (prop === 'first' || prop === 'run' || prop === 'all' || prop === 'raw') {
        const fn = target[prop] as (...a: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => retry(() => fn.apply(target, args));
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function retryOnBusy(db: D1Database, opts: { local?: boolean } = {}): D1Database {
  const retry = retryer(opts.local ?? false);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (query: string) => wrapStatement(target.prepare(query), retry);
      if (prop === 'batch') {
        return (stmts: Stmt[]) => retry(() => target.batch(stmts.map((s) => s[RAW] ?? s)));
      }
      if (prop === 'exec') return (q: string) => retry(() => target.exec(q));
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
