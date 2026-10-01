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

// ---------------------------------------------------------------------------------------------------------------
// Decision models served outside OpenRouter (ADR-0068). Cloudflare's clef and clef-flash (Workers AI) and Perplexity's
// decider take the Jev request (`{model, state, questions}`) and return Jev's answers, so the request is sent as asked
// and the response is read with `JevResponse`. Neither vendor returns a cost.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A model's published list rate, for a provider whose responses carry token counts but no cost. This is the one
 * exception to "money is the provider's `usage.cost`" (ADR-0068): without it these calls would log $0, and neither
 * the budget guard nor an eval's `--max-usd` would see them. Each rate names its source and the day it was read; a
 * price change means editing it here, and the model's next run reports the new cost.
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

/** USD for one response's usage at the model's list rate. */
export function listRateCost(rate: ListRate, usage: { input_tokens: number; output_tokens: number }): number {
  return (usage.input_tokens * rate.inputUsdPerMTok + usage.output_tokens * rate.outputUsdPerMTok) / 1e6;
}

export const WORKERS_AI_DECISION_PREFIX = 'cloudflare/';
export const PERPLEXITY_DECISION_PREFIX = 'perplexity/';

/** The rate for `model`, refused before any call when it has none: an unpriced model would run outside every cap. */
function rateOf(model: string, url: string): ListRate {
  const rate = DECISION_LIST_RATES[model];
  if (!rate) throw new HttpError(400, `${model} has no list rate in DECISION_LIST_RATES (ADR-0068)`, url);
  return rate;
}

/**
 * Checks each answer against the question it answers: the same type, a choice among the question's own options, and
 * score levels keyed `0..n-1`, as Jev keys them. Read any other way they would be scored as a uniform distribution and
 * still count as answered, so a mismatch fails the call instead. Answers to questions not asked are an error too;
 * questions left unanswered are the predictor's to report.
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

/**
 * The response as a `DecisionResponse`, priced at the list rate. A response that answers in the wrong shape, or from
 * a model not asked for, is thrown as rejected with its usage, so the failed row still carries what it cost.
 */
function readResponse(
  req: DecisionRequest,
  body: unknown,
  raw: unknown,
  opts: { rate: ListRate; snapshot: string; accepts: string[]; latencyMs: number; attempts: number },
): DecisionResponse {
  const r = JevResponse.parse(body);
  const res: DecisionResponse = {
    modelSnapshot: opts.snapshot,
    answers: Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, toDecisionAnswer(a)])),
    usage: {
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      costUsd: listRateCost(opts.rate, r.usage),
    },
    latencyMs: opts.latencyMs,
    attempts: opts.attempts,
    raw,
  };
  const problems = opts.accepts.includes(r.model) ? [] : [`answered as ${r.model}, not ${req.model}`];
  problems.push(...answerProblems(req, res.answers));
  if (problems.length)
    throw new RejectedResponseError(`${req.model}: ${problems.slice(0, 5).join('; ')}`, res);
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
 * Clef and clef-flash on Workers AI, over the REST API (`/accounts/{id}/ai/run/@cf/cloudflare/<name>`): the eval CLI
 * runs in Node, where there is no `AI` binding. The token needs Account · Workers AI · Read. Mimic's model IDs are
 * provider-neutral (`cloudflare/clef`); the body's `model` is the bare name the API asks for.
 */
export class WorkersAiDecisions implements DecisionProvider {
  readonly provider = 'workers-ai-decisions';
  constructor(private readonly opts: WorkersAiDecisionOptions = {}) {}

  /** `cloudflare/clef` runs as `@cf/cloudflare/clef`, with `clef` as the body's model. */
  static modelOf(model: string): { name: string; workersId: string } {
    const name = model.slice(model.lastIndexOf('/') + 1);
    return { name, workersId: `@cf/cloudflare/${name}` };
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const base = this.opts.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    const { name, workersId } = WorkersAiDecisions.modelOf(req.model);
    const url = `${base}/accounts/${this.opts.accountId ?? ''}/ai/run/${workersId}`;
    if (!this.opts.accountId)
      throw new HttpError(400, `${req.model} needs CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN)`, base);
    const rate = rateOf(req.model, url);
    const { json, latencyMs, attempts } = await requestJson({ timeoutMs: 15_000, ...this.opts }, url, {
      headers: authHeader('authorization', this.opts.apiToken, 'Bearer '),
      body: { model: name, state: req.state, questions: req.questions },
    });
    const env = CloudflareEnvelope.parse(json);
    if (!env.success || env.result === undefined)
      throw new HttpError(502, JSON.stringify(env.errors ?? []), url);
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

/**
 * Perplexity's decider on its Decisions API (`POST /v1/decisions`). Unknown top-level fields are a 400 there, so the
 * body is exactly `{model, state, questions}`. The response's `model` echoes the name sent, and there is no snapshot.
 */
export class PerplexityDecisions implements DecisionProvider {
  readonly provider = 'perplexity-decisions';
  constructor(private readonly opts: PerplexityDecisionOptions = {}) {}

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const url = `${this.opts.baseUrl ?? 'https://api.perplexity.ai'}/v1/decisions`;
    const rate = rateOf(req.model, url);
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

/**
 * One decision provider for the Gateway that sends each model to the vendor serving it: `cloudflare/` to Workers AI,
 * `perplexity/` to Perplexity, anything else to OpenRouter's Decisions API (Jev, span-01). `providerFor` names the
 * vendor in each `model_calls` row.
 */
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
    return this.route(model).provider;
  }

  decide(req: DecisionRequest): Promise<DecisionResponse> {
    return this.route(req.model).decide(req);
  }
}
