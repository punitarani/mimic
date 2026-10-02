import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CallContext,
  canonicalJson,
  type DecisionRequest,
  Gateway,
  type GatewayDeps,
  type RoutedDecision,
  sha256Hex,
} from '@mimic/core';
import { z } from 'zod';

/**
 * A gateway that keeps every answered decision request on disk, keyed by the request's content hash (ADR-0071).
 * A hit costs nothing and makes no call (so it is not logged: nothing was called); a miss goes through the gateway
 * as usual, logged with its trace (invariant 5). Reruns and repeated hypothetical states are free, and Jev's answer
 * to a request is fixed at its first draw, so policies compared on the same request see the same answer. Only
 * answered requests are kept; a failure is asked again next time.
 */

const Answer = z.union([
  z.object({ type: z.literal('noul'), p: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().optional(),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number().optional(),
    probabilities: z.record(z.string(), z.number()),
  }),
]);

const Cached = z.object({
  model: z.string(),
  modelSnapshot: z.string(),
  answers: z.record(z.string(), Answer),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
  latencyMs: z.number(),
});

export interface CacheStats {
  hits: number;
  misses: number;
  /** What the hits would have cost when they were first asked. */
  savedUsd: number;
}

export class CachingGateway extends Gateway {
  readonly stats: CacheStats = { hits: 0, misses: 0, savedUsd: 0 };
  private readonly inflight = new Map<string, Promise<RoutedDecision>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    deps: GatewayDeps,
    private readonly opts: { dir: string; maxInFlight?: number },
  ) {
    super(deps);
    mkdirSync(opts.dir, { recursive: true });
  }

  static keyOf(req: DecisionRequest): string {
    return sha256Hex(canonicalJson(req));
  }

  private pathOf(key: string): string {
    return join(this.opts.dir, key.slice(0, 2), `${key}.json`);
  }

  private read(key: string): RoutedDecision | null {
    const path = this.pathOf(key);
    if (!existsSync(path)) return null;
    try {
      const c = Cached.parse(JSON.parse(readFileSync(path, 'utf8')));
      return { ...c, raw: null };
    } catch {
      return null; // A torn or foreign file is a miss; the next answer overwrites it.
    }
  }

  private write(key: string, res: RoutedDecision): void {
    const path = this.pathOf(key);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const body: z.infer<typeof Cached> = {
      model: res.model,
      modelSnapshot: res.modelSnapshot,
      answers: res.answers,
      usage: {
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costUsd: res.usage.costUsd,
      },
      latencyMs: res.latencyMs,
    };
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, path);
  }

  private async slot(): Promise<() => void> {
    const max = this.opts.maxInFlight ?? Number.POSITIVE_INFINITY;
    if (this.active >= max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  override async decide(ctx: CallContext, req: DecisionRequest): Promise<RoutedDecision> {
    const key = CachingGateway.keyOf(req);
    const hit = this.read(key);
    if (hit) {
      this.stats.hits++;
      this.stats.savedUsd += hit.usage.costUsd;
      return { ...hit, usage: { ...hit.usage, costUsd: 0 }, latencyMs: 0 };
    }
    const pending = this.inflight.get(key);
    if (pending) {
      // The same request already in flight: share its answer; the first caller pays.
      const res = await pending;
      return { ...res, usage: { ...res.usage, costUsd: 0 } };
    }
    const call = (async () => {
      const release = await this.slot();
      try {
        this.stats.misses++;
        const res = await super.decide(ctx, req);
        this.write(key, res);
        return res;
      } finally {
        release();
      }
    })();
    this.inflight.set(key, call);
    try {
      return await call;
    } finally {
      this.inflight.delete(key);
    }
  }
}
