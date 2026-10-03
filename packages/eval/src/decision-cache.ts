import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CallContext,
  type ChatRequest,
  type ChatResponse,
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
 *
 * Chat requests are kept the same way (E10's choosers, docs/CHOOSER.md): keyed apart from decisions, and only a
 * complete reply (a reply cut off at its token cap is asked again). A model's reply to a request is fixed at its first
 * draw, so a rerun replays the same choices.
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

const CachedChat = z.object({
  content: z.string(),
  modelSnapshot: z.string(),
  provider: z.string().optional(),
  finishReason: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
  latencyMs: z.number(),
});

export interface CacheStats {
  hits: number;
  misses: number;
  /** What the hits would have cost when they were first asked. */
  savedUsd: number;
  /** The same for chat requests. */
  chat: { hits: number; misses: number; savedUsd: number };
}

export class CachingGateway extends Gateway {
  readonly stats: CacheStats = { hits: 0, misses: 0, savedUsd: 0, chat: { hits: 0, misses: 0, savedUsd: 0 } };
  private readonly inflight = new Map<string, Promise<RoutedDecision>>();
  private readonly chatInflight = new Map<string, Promise<ChatResponse>>();
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

  /** A chat request's key: wrapped, so it can never equal a decision request's. */
  static chatKeyOf(req: ChatRequest): string {
    return sha256Hex(canonicalJson({ chat: req }));
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

  private chatPathOf(key: string): string {
    return join(this.opts.dir, 'chat', key.slice(0, 2), `${key}.json`);
  }

  private readChat(key: string): ChatResponse | null {
    const path = this.chatPathOf(key);
    if (!existsSync(path)) return null;
    try {
      return { ...CachedChat.parse(JSON.parse(readFileSync(path, 'utf8'))), raw: null };
    } catch {
      return null;
    }
  }

  private writeChat(key: string, res: ChatResponse): void {
    const path = this.chatPathOf(key);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const body: z.infer<typeof CachedChat> = {
      content: res.content,
      modelSnapshot: res.modelSnapshot,
      ...(res.provider ? { provider: res.provider } : {}),
      ...(res.finishReason ? { finishReason: res.finishReason } : {}),
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

  override async chat(ctx: CallContext, req: ChatRequest): Promise<ChatResponse> {
    const key = CachingGateway.chatKeyOf(req);
    const hit = this.readChat(key);
    if (hit) {
      this.stats.chat.hits++;
      this.stats.chat.savedUsd += hit.usage.costUsd;
      return { ...hit, usage: { ...hit.usage, costUsd: 0 }, latencyMs: 0 };
    }
    const pending = this.chatInflight.get(key);
    if (pending) {
      const res = await pending;
      return { ...res, usage: { ...res.usage, costUsd: 0 } };
    }
    const call = (async () => {
      const release = await this.slot();
      try {
        this.stats.chat.misses++;
        const res = await super.chat(ctx, req);
        // A reply cut off at its cap is not an answer to keep.
        if (res.finishReason !== 'length') this.writeChat(key, res);
        return res;
      } finally {
        release();
      }
    })();
    this.chatInflight.set(key, call);
    try {
      return await call;
    } finally {
      this.chatInflight.delete(key);
    }
  }
}
