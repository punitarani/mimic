import type { DecisionProvider, Embedder, Enricher, LlmClient, PeopleSearch } from '@mimic/core';
import {
  FASTINO_DECISION_PREFIX,
  FastinoDecisions,
  PERPLEXITY_DECISION_PREFIX,
  PerplexityDecisions,
  RoutedDecisions,
  WORKERS_AI_DECISION_PREFIX,
  WorkersAiDecisions,
} from './decisions';
import { FixtureEnricher, FixturePeopleSearch } from './fixture-providers';
import type { FetchLike } from './http';
import { HashEmbedder, WorkersAiEmbedder } from './misc';
import { JevDecisions, OpenRouterChat, OpenRouterEmbedder } from './openrouter';
import { ExaEnricher, ExaPeopleSearch, ParallelEnricher, PerplexityPeopleSearch } from './search';

export interface ProviderEnv {
  OPENROUTER_API_KEY?: string;
  EXA_API_KEY?: string;
  PARALLEL_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  /** GLiDE on Fastino's API (ADR-0070): the eval CLI and live tests only. */
  FASTINO_API_KEY?: string;
  /**
   * Clef and clef-flash on Workers AI over REST (ADR-0068): the eval CLI and live tests only. The token needs
   * Account · Workers AI · Read. Deployed Workers set neither, and no served config names a `cloudflare/` model.
   */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** ADR-0002: set in local dev so outbound calls go through the proxy-aware relay. */
  EGRESS_RELAY?: string;
  /** 'workers-ai' | 'openrouter' | 'hash'. Defaults to Workers AI when the AI binding exists. */
  EMBEDDINGS_PROVIDER?: string;
  /** People search provider: 'exa' (default) | 'perplexity' | 'fixture' | 'none'. */
  SEARCH_PROVIDER?: string;
  /** Enrichment provider: 'exa' (default) | 'parallel' | 'fixture' | 'none'. */
  ENRICH_PROVIDER?: string;
}

export interface Providers {
  decisions: DecisionProvider;
  llm: LlmClient;
  embedder: Embedder;
  search?: PeopleSearch;
  enricher?: Enricher;
}

export function makeProviders(
  env: ProviderEnv,
  opts: {
    embeddingModel: string;
    ai?: { run(model: string, input: { text: string[] }): Promise<unknown> };
    fetch?: FetchLike;
  },
): Providers {
  const http = {
    ...(env.EGRESS_RELAY ? { relay: env.EGRESS_RELAY } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const or = { ...http, ...(env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY } : {}) };

  const embProvider = env.EMBEDDINGS_PROVIDER ?? (opts.ai && !env.EGRESS_RELAY ? 'workers-ai' : 'openrouter');
  let embedder: Embedder;
  if (embProvider === 'workers-ai' && opts.ai) embedder = new WorkersAiEmbedder(opts.ai, opts.embeddingModel);
  else if (embProvider === 'hash') embedder = new HashEmbedder();
  else embedder = new OpenRouterEmbedder(opts.embeddingModel, or);

  // Jev and span-01 on OpenRouter; clef on Workers AI; Perplexity's decider on Perplexity (ADR-0068); GLiDE on Fastino
  // (ADR-0070). The router is always built, so a model whose credentials are missing fails naming them rather than as
  // an OpenRouter 400.
  const decisions = new RoutedDecisions(new JevDecisions(or), [
    [
      WORKERS_AI_DECISION_PREFIX,
      // Never through the egress relay: it doesn't forward the Cloudflare account API, and only the CLI calls clef.
      new WorkersAiDecisions({
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(env.CLOUDFLARE_ACCOUNT_ID ? { accountId: env.CLOUDFLARE_ACCOUNT_ID } : {}),
        ...(env.CLOUDFLARE_API_TOKEN ? { apiToken: env.CLOUDFLARE_API_TOKEN } : {}),
      }),
    ],
    [
      PERPLEXITY_DECISION_PREFIX,
      new PerplexityDecisions({
        ...http,
        ...(env.PERPLEXITY_API_KEY ? { apiKey: env.PERPLEXITY_API_KEY } : {}),
      }),
    ],
    [
      FASTINO_DECISION_PREFIX,
      new FastinoDecisions({ ...http, ...(env.FASTINO_API_KEY ? { apiKey: env.FASTINO_API_KEY } : {}) }),
    ],
  ]);
  const p: Providers = { decisions, llm: new OpenRouterChat(or), embedder };
  const searchProvider = env.SEARCH_PROVIDER ?? 'exa';
  if (searchProvider === 'exa')
    p.search = new ExaPeopleSearch({ ...http, ...(env.EXA_API_KEY ? { apiKey: env.EXA_API_KEY } : {}) });
  else if (searchProvider === 'fixture') p.search = new FixturePeopleSearch();
  else if (searchProvider === 'perplexity') {
    p.search = new PerplexityPeopleSearch({
      ...http,
      ...(env.PERPLEXITY_API_KEY ? { apiKey: env.PERPLEXITY_API_KEY } : {}),
    });
  }
  // Exa by default: $0.001 and under a second for a professional profile (ADR-0034). Parallel stays selectable.
  const enrichProvider = env.ENRICH_PROVIDER ?? 'exa';
  if (enrichProvider === 'fixture') p.enricher = new FixtureEnricher();
  else if (enrichProvider === 'exa')
    p.enricher = new ExaEnricher({ ...http, ...(env.EXA_API_KEY ? { apiKey: env.EXA_API_KEY } : {}) });
  else if (enrichProvider === 'parallel') {
    p.enricher = new ParallelEnricher({
      ...http,
      ...(env.PARALLEL_API_KEY ? { apiKey: env.PARALLEL_API_KEY } : {}),
    });
  }
  return p;
}
