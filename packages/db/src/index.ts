import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import { DrizzleStore, type MimicDb } from './store';

export * from './bindings';
export * as schema from './schema';
export { DrizzleStore, type MimicDb } from './store';

export function d1Db(d1: D1Database): MimicDb {
  return drizzle(d1, { schema }) as unknown as MimicDb;
}

export function d1Store(d1: D1Database): DrizzleStore {
  return new DrizzleStore(d1Db(d1));
}
