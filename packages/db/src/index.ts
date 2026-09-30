import { drizzle } from 'drizzle-orm/d1';
import { retryOnBusy } from './busy';
import * as schema from './schema';
import { DrizzleStore, type MimicDb } from './store';

export * from './bindings';
export * as schema from './schema';
export { DrizzleStore, type MimicDb } from './store';

/** `local`: running on Miniflare in `pnpm dev` (ADR-0014). */
export function d1Db(d1: D1Database, opts: { local?: boolean } = {}): MimicDb {
  return drizzle(retryOnBusy(d1, opts), { schema }) as unknown as MimicDb;
}

export function d1Store(d1: D1Database, opts: { local?: boolean } = {}): DrizzleStore {
  return new DrizzleStore(d1Db(d1, opts));
}
