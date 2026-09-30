import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createClient } from '@libsql/client';
import type { BlobStore, KvStore } from '@mimic/core';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema';
import { DrizzleStore, type MimicDb } from './store';

export const MIGRATIONS_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'migrations');

/** A local SQLite database with the same Drizzle schema and migrations as D1 (for the CLI and tests). */
export async function openLocalDb(
  path: string,
): Promise<{ db: MimicDb; store: DrizzleStore; close: () => void }> {
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const client = createClient({ url: path === ':memory:' ? ':memory:' : `file:${path}` });
  const db = drizzle(client, { schema }) as unknown as MimicDb;
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  return { db, store: new DrizzleStore(db), close: () => client.close() };
}

export class FsBlobs implements BlobStore {
  constructor(private readonly root: string) {}
  private path(key: string) {
    const p = join(this.root, key);
    if (relative(this.root, p).startsWith('..')) throw new Error('Invalid key');
    return p;
  }
  async put(key: string, body: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch {
      return null;
    }
  }
  async list(prefix: string) {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = relative(this.root, full).split('\\').join('/');
          if (key.startsWith(prefix)) out.push(key);
        }
      }
    };
    await walk(this.root);
    return out.sort();
  }
  async delete(keys: string[]) {
    for (const k of keys) await rm(this.path(k), { force: true });
  }
}

export class MemoryBlobs implements BlobStore {
  readonly data = new Map<string, string>();
  async put(key: string, body: string) {
    this.data.set(key, body);
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(keys: string[]) {
    for (const k of keys) this.data.delete(k);
  }
}

export class MemoryKv implements KvStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}
