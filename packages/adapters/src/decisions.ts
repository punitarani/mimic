import {
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
  PPLX_DECIDER_MODEL,
  RejectedResponseError,
} from '@mimic/core';
import { z } from 'zod';
import { authHeader, HttpError, type HttpOptions, requestJson } from './http';
import { JevResponse, toDecisionAnswer } from './openrouter';

// Decision models served outside OpenRouter (ADR-0068): clef and clef-flash on Workers AI, Perplexity's decider on
// Perplexity. Both take Jev's request and return Jev's answers, but neither returns a cost.

/**
 * A published list rate, the one exception to "money is the provider's `usage.cost`" (ADR-0068): these calls would
 * otherwise log $0 and escape every cap. A price change is an edit here.
 */
export interface ListRate {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  source: string;
  checkedAt: string;
}

export const DECISION_LIST_RATES: Readonly<Record<string, ListRate>> = {
  [CLEF_MODEL]: {
    inputUsdPerMTok: 0.24,
    outputUsdPerMTok: 0,
    source: 'https://developers.cloudflare.com/workers-ai/models/clef/',
    checkedAt: '2026-10-01',
  },
  [CLEF_FLASH_MODEL]: {
    inputUsdPerMTok: 0.09,
    outputUsdPerMTok: 0,
    source: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
    checkedAt: '2026-10-01',
  },
  [PPLX_DECIDER_MODEL]: {
    inputUsdPerMTok: 0.04,
    outputUsdPerMTok: 0,
    source: 'https://docs.perplexity.ai/docs/decisions/quickstart',
    checkedAt: '2026-10-01',
  },
};

export function listRateCost(rate: ListRate, usage: { input_tokens: number; output_tokens: number }): number {
  return (usage.input_tokens * rate.inputUsdPerMTok + usage.output_tokens * rate.outputUsdPerMTok) / 1e6;
}

export const WORKERS_AI_DECISION_PREFIX = 'cloudflare/';
export const PERPLEXITY_DECISION_PREFIX = 'perplexity/';

/** Missing local setup (a credential, a list rate): refused before any request, and not worth retrying. */
export class DecisionSetupError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DecisionSetupError';
  }
}

function rateOf(model: string): ListRate {
  const rate = DECISION_LIST_RATES[model];
  if (!rate) throw new DecisionSetupError(`${model} has no list rate in DECISION_LIST_RATES (ADR-0068)`);
  return rate;
}

/**
 * What is wrong with each answer, if anything: the wrong type, a choice outside the question's options, or score levels
 * not keyed `0..n-1` as Jev keys them. Read anyway, such an answer would be scored as a near-uniform distribution and
 * still count as answered.
 */
export function answerProblems(req: DecisionRequest, answers: Record<string, DecisionAnswer>): string[] {
  const problems: string[] = [];
  for (const [key, a] of Object.entries(answers)) {
    const q = req.questions[key];
    if (!q) {
      problems.push(`${key}: answers no question asked`);
      continue;
    }
    if (a.type !== q.type) {
      problems.push(`${key}: a ${a.type} answer to a ${q.type} question`);
      continue;
    }
    if (a.type === 'noul') continue;
    const allowed =
      q.type === 'choice'
        ? Object.keys(q.criteria)
        : q.type === 'score'
          ? q.criteria.map((_, i) => String(i))
          : [];
    const stray = Object.keys(a.probabilities).filter((k) => !allowed.includes(k));
    if (stray.length)
      problems.push(`${key}: probabilities for ${stray.slice(0, 3).join(', ')} not in the question`);
    if (a.type === 'choice' && !allowed.includes(a.choice))
      problems.push(`${key}: chose ${a.choice}, not an option`);
  }
  return problems;
}

/** Read before the answers, so a response that fails to parse still logs what it cost. */
const Billed = z
  .object({
    usage: z
      .object({ input_tokens: z.number(), output_tokens: z.number(), cost: z.number().optional() })
      .passthrough(),
  })
  .passthrough();

/**
 * The response as a `DecisionResponse`, priced from `usage.cost` if the vendor sends one, else at the list rate. A
 * response that can't be read, or comes from another model, is rejected whole (with its cost); a malformed answer is
 * dropped, so only its question fails, and the trace keeps the raw response.
 */
function readResponse(
  req: DecisionRequest,
  body: unknown,
  raw: unknown,
  opts: { rate: ListRate; snapshot: string; accepts: string[]; latencyMs: number; attempts: number },
): DecisionResponse {
  const billed = Billed.safeParse(body);
  const u = billed.success ? billed.data.usage : null;
  const res: DecisionResponse = {
    modelSnapshot: opts.snapshot,
    answers: {},
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      costUsd: u ? (u.cost ?? listRateCost(opts.rate, u)) : 0,
    },
    latencyMs: opts.latencyMs,
    attempts: opts.attempts,
    raw,
  };
  const parsed = JevResponse.safeParse(body);
  if (!parsed.success)
    throw new RejectedResponseError(
      `${req.model}: unreadable response (${parsed.error.issues[0]?.message})`,
      res,
    );
  if (!opts.accepts.includes(parsed.data.model))
    throw new RejectedResponseError(`${req.model}: answered as ${parsed.data.model}`, res);
  for (const [key, a] of Object.entries(parsed.data.answers)) {
    const answer = toDecisionAnswer(a);
    if (!answerProblems(req, { [key]: answer }).length) res.answers[key] = answer;
  }
  return res;
}

export interface WorkersAiDecisionOptions extends HttpOptions {
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
}

const CloudflareEnvelope = z
  .object({
    success: z.boolean(),
    result: z.unknown().optional(),
    errors: z.array(z.object({ code: z.number().optional(), message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/**
 * Clef and clef-flash over Workers AI's REST API, since the eval CLI runs in Node without the `AI` binding. The token
 * needs Account · Workers AI · Read.
 */
export class WorkersAiDecisions implements DecisionProvider {
  readonly provider = 'workers-ai-decisions';
  constructor(private readonly opts: WorkersAiDecisionOptions = {}) {}

  /** `cloudflare/clef` runs as `@cf/cloudflare/clef`, with the bare `clef` as the body's model. */
  static modelOf(model: string): { name: string; workersId: string } {
    const name = model.slice(model.lastIndexOf('/') + 1);
    return { name, workersId: `@cf/cloudflare/${name}` };
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const base = this.opts.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    const { name, workersId } = WorkersAiDecisions.modelOf(req.model);
    if (!this.opts.accountId)
      throw new DecisionSetupError(`${req.model} needs CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN)`);
    const url = `${base}/accounts/${this.opts.accountId}/ai/run/${workersId}`;
    const rate = rateOf(req.model);
    const { json, latencyMs, attempts } = await requestJson({ timeoutMs: 15_000, ...this.opts }, url, {
      headers: authHeader('authorization', this.opts.apiToken, 'Bearer '),
      body: { model: name, state: req.state, questions: req.questions },
    });
    const env = CloudflareEnvelope.parse(json);
    if (!env.success || env.result === undefined) {
      // Cloudflare's 10000 is "Authentication error": a refused token, which no retry fixes.
      const refused = env.errors?.some((e) => e.code === 10000);
      throw new HttpError(refused ? 401 : 502, JSON.stringify(env.errors ?? []), url);
    }
    return readResponse(req, env.result, json, {
      rate,
      snapshot: workersId,
      accepts: [name, workersId, req.model],
      latencyMs,
      attempts,
    });
  }
}

export interface PerplexityDecisionOptions extends HttpOptions {
  apiKey?: string;
  baseUrl?: string;
}

/** Perplexity's decider. Unknown top-level fields are a 400 there, so the body is exactly the three it takes. */
export class PerplexityDecisions implements DecisionProvider {
  readonly provider = 'perplexity-decisions';
  constructor(private readonly opts: PerplexityDecisionOptions = {}) {}

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const url = `${this.opts.baseUrl ?? 'https://api.perplexity.ai'}/v1/decisions`;
    const rate = rateOf(req.model);
    const name = req.model.slice(PERPLEXITY_DECISION_PREFIX.length);
    const { json, latencyMs, attempts } = await requestJson({ timeoutMs: 15_000, ...this.opts }, url, {
      headers: authHeader('authorization', this.opts.apiKey, 'Bearer '),
      body: { model: name, state: req.state, questions: req.questions },
    });
    return readResponse(req, json, json, {
      rate,
      snapshot: name,
      accepts: [name, req.model],
      latencyMs,
      attempts,
    });
  }
}

/** Sends each model to the vendor that serves it by prefix, else to the fallback (OpenRouter: Jev, span-01). */
export class RoutedDecisions implements DecisionProvider {
  readonly provider: string;
  constructor(
    private readonly fallback: DecisionProvider,
    private readonly routes: ReadonlyArray<[prefix: string, provider: DecisionProvider]>,
  ) {
    this.provider = fallback.provider;
  }

  private route(model: string): DecisionProvider {
    return this.routes.find(([prefix]) => model.startsWith(prefix))?.[1] ?? this.fallback;
  }

  providerFor(model: string): string {
    const p = this.route(model);
    return p.providerFor?.(model) ?? p.provider;
  }

  decide(req: DecisionRequest): Promise<DecisionResponse> {
    return this.route(req.model).decide(req);
  }
}
