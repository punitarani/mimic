import type {
  ChatRequest,
  ChatResponse,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  Embedder,
  EmbedResult,
  Enricher,
  EnrichmentResult,
  LlmClient,
  PeopleSearch,
  PeopleSearchResult,
  Usage,
} from './types';

export interface CallContext {
  purpose: string;
  mimicId?: string | null;
  configHash?: string | null;
  jobKey?: string | null;
  /**
   * false: operator research work (a backfill) that is neither refused by nor charged to the mimic's session budget.
   * The call is still logged with its cost. Default true.
   */
  budgeted?: boolean;
}

export interface ModelCallRecord {
  id: string;
  mimicId: string | null;
  jobKey: string | null;
  purpose: string;
  provider: string;
  model: string;
  modelSnapshot: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  configHash: string | null;
  r2TraceKey: string;
  createdAt: number;
}

export interface ModelCallTrace {
  id: string;
  purpose: string;
  provider: string;
  model: string;
  request: unknown;
  response?: unknown;
  error?: string;
  createdAt: number;
}

/** Persists the `model_calls` row and the trace blob. */
export interface CallLog {
  write(record: ModelCallRecord, trace: ModelCallTrace): Promise<void>;
}

/** Per-mimic spend ledger backing the budget guard (PLAN §11 Limits). */
export interface BudgetLedger {
  get(mimicId: string): Promise<{ spendUsd: number; budgetUsd: number } | null>;
  add(mimicId: string, usd: number): Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly mimicId: string,
    readonly spendUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`Budget exceeded for mimic ${mimicId}: $${spendUsd.toFixed(4)} ≥ $${budgetUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

/** HTTP statuses worth retrying: timeouts, rate limits and upstream/provider errors. */
export const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504, 524, 529,
]);

/**
 * Whether a failed provider call may succeed if retried later: timeouts, network errors, transient statuses and
 * malformed provider responses are; the budget guard and other HTTP statuses (bad request, unknown model) are not.
 */
export function isTransientError(e: unknown): boolean {
  if (e instanceof BudgetExceededError) return false;
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return TRANSIENT_HTTP_STATUS.has(status);
  return true;
}

export interface CallDeps {
  log: CallLog;
  budget?: BudgetLedger;
  clock: () => number;
  newId: () => string;
}

interface CallOutcome {
  usage: Usage;
  modelSnapshot: string | null;
  latencyMs: number;
  raw: unknown;
}

export function traceKey(id: string, createdAt: number): string {
  return `traces/${new Date(createdAt).toISOString().slice(0, 10)}/${id}.json`;
}

const SECRET_PATTERNS = [/sk-or-[A-Za-z0-9-_]+/g, /Bearer\s+[A-Za-z0-9._-]+/gi];

/** Strips anything that looks like a credential from a trace. Adapters never pass headers here anyway. */
export function redact(value: unknown): unknown {
  const s = JSON.stringify(value ?? null, (k, v) =>
    /^(authorization|x-api-key|api[-_]?key)$/i.test(k) ? '[redacted]' : v,
  );
  return JSON.parse(SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '[redacted]'), s));
}

/**
 * Wraps every model and search call (PLAN §3.5): enforces the budget guard, then writes a `model_calls` row and
 * a redacted trace whether the call succeeds or fails.
 */
export async function withModelCall<T extends CallOutcome>(
  deps: CallDeps,
  ctx: CallContext & { provider: string; model: string },
  request: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const budget = ctx.mimicId && ctx.budgeted !== false ? deps.budget : undefined;
  if (ctx.mimicId && budget) {
    const b = await budget.get(ctx.mimicId);
    if (b && b.spendUsd >= b.budgetUsd) throw new BudgetExceededError(ctx.mimicId, b.spendUsd, b.budgetUsd);
  }
  const id = deps.newId();
  const createdAt = deps.clock();
  const started = deps.clock();
  const base = {
    id,
    mimicId: ctx.mimicId ?? null,
    jobKey: ctx.jobKey ?? null,
    purpose: ctx.purpose,
    provider: ctx.provider,
    model: ctx.model,
    configHash: ctx.configHash ?? null,
    r2TraceKey: traceKey(id, createdAt),
    createdAt,
  };
  const trace = { id, purpose: ctx.purpose, provider: ctx.provider, model: ctx.model, createdAt };
  try {
    const out = await fn();
    await deps.log.write(
      {
        ...base,
        modelSnapshot: out.modelSnapshot,
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        costUsd: out.usage.costUsd,
        latencyMs: out.latencyMs,
        ok: true,
        error: null,
      },
      { ...trace, request: redact(request), response: redact(out.raw) },
    );
    if (ctx.mimicId && budget && out.usage.costUsd > 0) await budget.add(ctx.mimicId, out.usage.costUsd);
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.log.write(
      {
        ...base,
        modelSnapshot: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: deps.clock() - started,
        ok: false,
        error: message.slice(0, 1000),
      },
      { ...trace, request: redact(request), error: message },
    );
    throw err;
  }
}

export interface GatewayDeps extends CallDeps {
  decisions: DecisionProvider;
  llm: LlmClient;
  embedder?: Embedder;
  search?: PeopleSearch;
  enricher?: Enricher;
}

/** The only way engine code reaches a provider: every call is logged and budget-guarded. */
export class Gateway {
  constructor(readonly deps: GatewayDeps) {}

  decide(ctx: CallContext, req: DecisionRequest): Promise<DecisionResponse> {
    return withModelCall(
      this.deps,
      { ...ctx, provider: this.deps.decisions.provider, model: req.model },
      req,
      () => this.deps.decisions.decide(req),
    );
  }

  chat(ctx: CallContext, req: ChatRequest): Promise<ChatResponse> {
    return withModelCall(
      this.deps,
      { ...ctx, provider: this.deps.llm.provider, model: req.model },
      req,
      async () => {
        const r = await this.deps.llm.chat(req);
        return { ...r, modelSnapshot: r.modelSnapshot };
      },
    );
  }

  async embed(ctx: CallContext, texts: string[]): Promise<EmbedResult> {
    const e = this.deps.embedder;
    if (!e) throw new Error('No embedder configured');
    return withModelCall(this.deps, { ...ctx, provider: e.provider, model: e.model }, { texts }, async () => {
      const r = await e.embed(texts);
      return { ...r, modelSnapshot: r.model, raw: { dims: r.vectors[0]?.length ?? 0, n: r.vectors.length } };
    });
  }

  async searchPeople(ctx: CallContext, query: string, numResults: number): Promise<PeopleSearchResult> {
    const s = this.deps.search;
    if (!s) throw new Error('No people search configured');
    return withModelCall(
      this.deps,
      { ...ctx, provider: s.provider, model: `${s.provider}:people` },
      { query, numResults },
      async () => {
        const r = await s.search(query, { numResults });
        return { ...r, usage: { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd }, modelSnapshot: null };
      },
    );
  }

  async enrich(ctx: CallContext, subject: Parameters<Enricher['enrich']>[0]): Promise<EnrichmentResult> {
    const en = this.deps.enricher;
    if (!en) throw new Error('No enricher configured');
    return withModelCall(
      this.deps,
      { ...ctx, provider: en.provider, model: `${en.provider}:task` },
      subject,
      async () => {
        const r = await en.enrich(subject);
        return { ...r, usage: { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd }, modelSnapshot: null };
      },
    );
  }
}
