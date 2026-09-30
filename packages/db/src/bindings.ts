import {
  type BlobStore,
  type BudgetLedger,
  type CallLog,
  cosine,
  type KvStore,
  type ModelCallRecord,
  type ModelCallTrace,
  PipelineConfig,
  type SpendCaps,
  type SpendLimits,
  type Store,
  spendCaps,
  type VectorIndex,
  type VectorRecord,
} from '@mimic/core';
import { and, eq, inArray } from 'drizzle-orm';
import * as s from './schema';
import type { MimicDb } from './store';

type Retry = <T>(fn: () => Promise<T>) => Promise<T>;
const once: Retry = (fn) => fn();

export class R2Blobs implements BlobStore {
  /** `retry`: local-dev lock retry (ADR-0014); identity in deployed envs. */
  constructor(
    private readonly bucket: R2Bucket,
    private readonly retry: Retry = once,
  ) {}
  async put(key: string, body: string, contentType = 'application/json') {
    await this.retry(() => this.bucket.put(key, body, { httpMetadata: { contentType } }));
  }
  async get(key: string) {
    return this.retry(async () => {
      const o = await this.bucket.get(key);
      return o ? o.text() : null;
    });
  }
  async list(prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
  async delete(keys: string[]) {
    if (keys.length) await this.bucket.delete(keys);
  }
}

export class CfKv implements KvStore {
  constructor(
    private readonly ns: KVNamespace,
    private readonly retry: Retry = once,
  ) {}
  get(key: string) {
    return this.retry(() => this.ns.get(key));
  }
  async put(key: string, value: string, opts?: { ttlSeconds?: number }) {
    await this.retry(() =>
      this.ns.put(
        key,
        value,
        opts?.ttlSeconds ? { expirationTtl: Math.max(60, opts.ttlSeconds) } : undefined,
      ),
    );
  }
  async delete(key: string) {
    await this.retry(() => this.ns.delete(key));
  }
  async list(prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ns.list({ prefix, ...(cursor ? { cursor } : {}) });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return keys;
  }
}

/** Vectorize, with metadata indexes on `mimicId` and `kind`. Queries are always filtered by mimicId. */
export class VectorizeVectors implements VectorIndex {
  constructor(private readonly index: VectorizeIndex) {}
  async upsert(recs: VectorRecord[]) {
    if (recs.length)
      await this.index.upsert(recs.map((r) => ({ id: r.id, values: r.values, metadata: r.metadata })));
  }
  async getByIds(ids: string[]) {
    if (!ids.length) return [];
    const out: VectorRecord[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const got = await this.index.getByIds(ids.slice(i, i + 20));
      for (const v of got) {
        out.push({
          id: v.id,
          values: Array.from(v.values as ArrayLike<number>),
          metadata: v.metadata as VectorRecord['metadata'],
        });
      }
    }
    return out;
  }
  async query(
    values: number[],
    opts: { mimicId: string; kind?: VectorRecord['metadata']['kind']; topK: number },
  ) {
    const filter: VectorizeVectorMetadataFilter = { mimicId: opts.mimicId };
    if (opts.kind) filter.kind = opts.kind;
    const r = await this.index.query(values, { topK: opts.topK, filter });
    return r.matches.map((m) => ({ id: m.id, score: m.score }));
  }
  async deleteByIds(ids: string[]) {
    if (ids.length) await this.index.deleteByIds(ids);
  }
}

/** ADR-0003: brute-force vector index in SQL, for local dev (Vectorize has no local mode) and the Node CLI. */
export class SqlVectors implements VectorIndex {
  constructor(private readonly db: MimicDb) {}
  async upsert(recs: VectorRecord[]) {
    for (const r of recs) {
      const row = {
        id: r.id,
        mimicId: r.metadata.mimicId,
        kind: r.metadata.kind,
        facetIds: r.metadata.facetIds,
        seq: r.metadata.seq,
        valuesJson: JSON.stringify(r.values),
      };
      await this.db
        .insert(s.vectors)
        .values(row)
        .onConflictDoUpdate({
          target: s.vectors.id,
          set: { valuesJson: row.valuesJson, facetIds: row.facetIds, seq: row.seq },
        });
    }
  }
  async getByIds(ids: string[]) {
    if (!ids.length) return [];
    const out: VectorRecord[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await this.db
        .select()
        .from(s.vectors)
        .where(inArray(s.vectors.id, ids.slice(i, i + 90)))
        .all();
      for (const r of rows) out.push(toRecord(r));
    }
    return out;
  }
  async query(
    values: number[],
    opts: { mimicId: string; kind?: VectorRecord['metadata']['kind']; topK: number },
  ) {
    const rows = await this.db
      .select()
      .from(s.vectors)
      .where(
        opts.kind
          ? and(eq(s.vectors.mimicId, opts.mimicId), eq(s.vectors.kind, opts.kind))
          : eq(s.vectors.mimicId, opts.mimicId),
      )
      .all();
    return rows
      .map((r) => ({ id: r.id, score: cosine(values, JSON.parse(r.valuesJson) as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }
  async deleteByIds(ids: string[]) {
    for (let i = 0; i < ids.length; i += 90)
      await this.db.delete(s.vectors).where(inArray(s.vectors.id, ids.slice(i, i + 90)));
  }
}

function toRecord(r: typeof s.vectors.$inferSelect): VectorRecord {
  return {
    id: r.id,
    values: JSON.parse(r.valuesJson) as number[],
    metadata: {
      mimicId: r.mimicId,
      kind: r.kind as VectorRecord['metadata']['kind'],
      facetIds: r.facetIds,
      seq: r.seq,
    },
  };
}

/** `model_calls` row in D1 plus the full (redacted) trace in R2 (PLAN §3.5). */
export class StoreCallLog implements CallLog {
  constructor(
    private readonly store: Store,
    private readonly blobs: BlobStore,
  ) {}
  async write(record: ModelCallRecord, trace: ModelCallTrace) {
    await Promise.all([
      this.store.insertModelCall(record),
      this.blobs.put(record.r2TraceKey, JSON.stringify(trace)).catch(() => {}),
    ]);
  }
}

/**
 * Budget guard backed by `mimics.spend_usd` and the caps from the mimic's config and the deploy's spend limits
 * (`spendCaps`, ADR-0035): the whole cap, and the session's share the gateway holds session work to.
 */
export class StoreBudget implements BudgetLedger {
  private readonly caps = new Map<string, SpendCaps>();
  constructor(
    private readonly store: Store,
    private readonly limits: SpendLimits = {},
  ) {}
  async get(mimicId: string) {
    const m = await this.store.getMimic(mimicId);
    if (!m) return null;
    let caps = this.caps.get(m.configHash);
    if (caps === undefined) {
      const c = await this.store.getConfig(m.configHash);
      caps = c
        ? spendCaps(PipelineConfig.parse(JSON.parse(c.json)), this.limits)
        : { totalUsd: Number.POSITIVE_INFINITY, sessionUsd: Number.POSITIVE_INFINITY };
      this.caps.set(m.configHash, caps);
    }
    return { spendUsd: m.spendUsd, budgetUsd: caps.totalUsd, sessionUsd: caps.sessionUsd };
  }
  add(mimicId: string, usd: number) {
    return this.store.addSpend(mimicId, usd);
  }
}
