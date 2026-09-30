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
  ProviderCallRunner,
  Usage,
} from './types';

export interface CallContext {
  purpose: string;
  mimicId?: string | null;
  configHash?: string | null;
  jobKey?: string | null;
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
  /** The attempt that answered; earlier attempts that got a transient error are counted in `attempts`. */
  latencyMs: number;
  /** HTTP attempts the call took (ADR-0037); 1 when omitted. */
  attempts?: number;
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
  /** `budgetUsd` is the whole cap; `sessionUsd`, when set, is the session's share of it (ADR-0035). */
  get(mimicId: string): Promise<{ spendUsd: number; budgetUsd: number; sessionUsd?: number } | null>;
  add(mimicId: string, usd: number): Promise<void>;
}

/**
 * Which cap a call is held to (ADR-0035):
 * - `session`: background session and research work, held to the session's share so it never draws on the reserve.
 * - `serve`: the calls that serve a session question. `/next` admits a serve only under the session's share, and the
 *   guard then holds its calls to the whole cap, so a serve that starts under the share is never cut off halfway.
 * - `page`: asking, teaching, SOUL.md and learning from answers, held to the whole cap.
 */
export type SpendScope = 'session' | 'serve' | 'page';

/** Every purpose an engine call is logged under, and its scope. A test keeps this complete. */
export const SPEND_SCOPES: Readonly<Record<string, SpendScope>> = {
  'predict.primary': 'serve',
  'predict.baseline': 'serve',
  'predict.fallback': 'serve',
  'select.bald': 'serve',
  'predict.shadow': 'session',
  'predict.backfill': 'session',
  'pool.generate': 'session',
  'pool.gate': 'session',
  'embed.question': 'session',
  hypotheses: 'session',
  'identity.lookup': 'session',
  'identity.search': 'session',
  'identity.rank': 'session',
  'identity.enrich': 'session',
  'embed.fact': 'session',
  'embed.qa': 'page',
  'traits.read': 'page',
  reflect: 'page',
  'facets.occupation': 'page',
  'playground.draft': 'page',
  'playground.predict': 'page',
  'playground.baseline': 'page',
  'playground.rationale': 'page',
  'soul.draft': 'page',
};

/** An unlisted purpose is held to the session's share, so a new call can't spend the reserve by accident. */
export function spendScope(purpose: string): SpendScope {
  return SPEND_SCOPES[purpose] ?? 'session';
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

/** A call that ran out of time (`AbortSignal.timeout`): the model didn't answer in time. */
export function isTimeoutError(e: unknown): boolean {
  const x = e as { name?: unknown; message?: unknown } | null;
  return (
    x?.name === 'TimeoutError' ||
    (typeof x?.message === 'string' && x.message.includes('aborted due to timeout'))
  );
}

/**
 * Whether a failed provider call may succeed if retried later: network errors, transient statuses and malformed
 * provider responses may. The budget guard, other HTTP statuses (bad request, unknown model) and timeouts (a slow
 * model, which a retry would only hide) won't. Queued retries are bounded (MAX_JOB_ATTEMPTS), so a permanent fault
 * that looks transient is stored after the last attempt.
 */
export function isTransientError(e: unknown): boolean {
  if (e instanceof BudgetExceededError || isTimeoutError(e)) return false;
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
  attempts?: number;
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
  if (ctx.mimicId && deps.budget) {
    const b = await deps.budget.get(ctx.mimicId);
    if (b) {
      const cap = spendScope(ctx.purpose) === 'session' ? (b.sessionUsd ?? b.budgetUsd) : b.budgetUsd;
      if (b.spendUsd >= cap) throw new BudgetExceededError(ctx.mimicId, b.spendUsd, cap);
    }
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
        attempts: out.attempts ?? 1,
        ok: true,
        error: null,
      },
      { ...trace, request: redact(request), response: redact(out.raw) },
    );
    if (ctx.mimicId && deps.budget && out.usage.costUsd > 0)
      await deps.budget.add(ctx.mimicId, out.usage.costUsd);
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

  /** True when the people search provider can resolve a profile URL directly. */
  get canLookupPeople(): boolean {
    return typeof this.deps.search?.lookup === 'function';
  }

  async lookupPerson(ctx: CallContext, url: string): Promise<PeopleSearchResult> {
    const s = this.deps.search;
    if (!s?.lookup) throw new Error('No profile lookup configured');
    const lookup = s.lookup.bind(s);
    return withModelCall(
      this.deps,
      { ...ctx, provider: s.provider, model: `${s.provider}:contents` },
      { url },
      async () => {
        const r = await lookup(url);
        return { ...r, usage: { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd }, modelSnapshot: null };
      },
    );
  }

  /** True when confirming a search candidate that carries facts needs no enrichment call (ADR-0034). */
  get enrichmentUsesSearchFacts(): boolean {
    return this.deps.enricher?.usesSearchFacts === true;
  }

  /** Each provider call the enricher makes is logged as its own `model_calls` row (PLAN §3.5). */
  async enrich(ctx: CallContext, subject: Parameters<Enricher['enrich']>[0]): Promise<EnrichmentResult> {
    const en = this.deps.enricher;
    if (!en) throw new Error('No enricher configured');
    const run: ProviderCallRunner = (model, request, call) =>
      withModelCall(this.deps, { ...ctx, provider: en.provider, model }, request, async () => {
        const r = await call();
        return { ...r, usage: { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd }, modelSnapshot: null };
      });
    return en.enrich(subject, run);
  }
}
