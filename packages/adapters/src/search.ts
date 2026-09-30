import {
  type EnrichedFact,
  type Enricher,
  type EnrichmentResult,
  type PeopleSearch,
  type PeopleSearchResult,
  type PersonCandidate,
  type ProviderCallRunner,
  profileKey,
} from '@mimic/core';
import { z } from 'zod';
import { authHeader, type HttpOptions, requestJson } from './http';

// ---------------------------------------------------------------------------------------------------------------
// Exa people search (PLAN §9.2 step 1)
// ---------------------------------------------------------------------------------------------------------------

const ExaEntity = z
  .object({
    type: z.string().optional(),
    properties: z
      .object({
        name: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        workHistory: z
          .array(
            z
              .object({
                title: z.string().nullable().optional(),
                dates: z
                  .object({ from: z.string().nullable().optional(), to: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
                company: z
                  .object({ name: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
        educationHistory: z
          .array(
            z
              .object({
                degree: z.string().nullable().optional(),
                institution: z
                  .object({ name: z.string().nullable().optional() })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ExaResponse = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string().optional(),
          title: z.string().nullable().optional(),
          url: z.string(),
          author: z.string().nullable().optional(),
          highlights: z.array(z.string()).optional(),
          text: z.string().optional(),
          summary: z.string().optional(),
          entities: z.array(ExaEntity).optional(),
        })
        .passthrough(),
    ),
    costDollars: z.object({ total: z.number() }).passthrough().optional(),
  })
  .passthrough();
type ExaResult = z.infer<typeof ExaResponse>['results'][number];
type ExaPerson = NonNullable<z.infer<typeof ExaEntity>['properties']>;
type ExaJob = NonNullable<ExaPerson['workHistory']>[number];

export interface ExaOptions extends HttpOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Identity calls are bounded so one slow page can't hold the identity queue for long (ADR-0034): search waits 10 s,
 * a page read 8 s, each retried once; a schema summary gets 15 s and no retry.
 */
const SEARCH_TIMEOUT = { timeoutMs: 10_000, retries: 1 };
const CONTENTS_TIMEOUT = { timeoutMs: 8_000, retries: 1 };
const SUMMARY_TIMEOUT = { timeoutMs: 15_000, retries: 0 };

/** One Exa call, parsed. `bounds` are the defaults; options passed to the adapter win (tests inject fetch). */
async function exa(
  opts: ExaOptions,
  path: '/search' | '/contents',
  body: Record<string, unknown>,
  bounds: HttpOptions,
): Promise<{ r: z.infer<typeof ExaResponse>; raw: unknown; costUsd: number; latencyMs: number }> {
  const started = Date.now();
  const { json } = await requestJson(
    { ...bounds, ...opts },
    `${opts.baseUrl ?? 'https://api.exa.ai'}${path}`,
    {
      headers: authHeader('x-api-key', opts.apiKey),
      body,
    },
  );
  const r = ExaResponse.parse(json);
  return { r, raw: json, costUsd: r.costDollars?.total ?? 0, latencyMs: Date.now() - started };
}

const personOf = (r: ExaResult | undefined): ExaPerson | undefined =>
  r?.entities?.find((e) => e.type === 'person')?.properties;

/**
 * A role is current when it has a start date and no end date. An undated role is not assumed current: Exa's
 * `to: null` means "current" only when the source dates the role at all.
 */
export function isCurrentJob(w: ExaJob): boolean {
  return !!w.dates?.from && !w.dates.to;
}

/** Structured data from a professional profile: reliable, so facts from it rank above extracted ones. */
const ENTITY_CONFIDENCE = 0.85;
/** Fields an LLM pulled out of a page's text. */
const EXTRACTED_CONFIDENCE = 0.6;

/**
 * Facts from an Exa person entity (ADR-0034): the current role and employers, past employers, schools and location.
 * Skills and interests aren't in the entity; extracting them from profile text was noisy in live checks, so they are
 * left to the person's answers. `url`, when given, is every fact's source; facts carried on a search candidate leave
 * it to the candidate's URL.
 */
export function exaEntityFacts(person: ExaPerson, url?: string): EnrichedFact[] {
  const facts: EnrichedFact[] = [];
  const add = (predicate: string, object: string | null | undefined) => {
    const v = object?.trim();
    if (!v) return;
    if (facts.some((f) => f.predicate === predicate && f.object.toLowerCase() === v.toLowerCase())) return;
    const f: EnrichedFact = { predicate, object: v.slice(0, 200), confidence: ENTITY_CONFIDENCE };
    if (url) f.sourceUrl = url;
    facts.push(f);
  };
  const jobs = (person.workHistory ?? []).filter((w) => w.title || w.company?.name);
  const current = jobs.filter(isCurrentJob);
  add('jobTitle', current[0]?.title);
  for (const w of current.slice(0, 3)) add('worksAt', w.company?.name);
  const currentEmployers = new Set(current.map((w) => w.company?.name?.trim().toLowerCase()));
  for (const w of jobs.filter((j) => !isCurrentJob(j)).slice(0, 8)) {
    if (!currentEmployers.has(w.company?.name?.trim().toLowerCase())) add('workedAt', w.company?.name);
  }
  // The school alone: a degree in the object would make "Pomona College (BA)" a second organization in the KG.
  for (const e of (person.educationHistory ?? []).slice(0, 4)) add('educatedAt', e.institution?.name);
  add('livesIn', person.location);
  return facts;
}

/**
 * Builds a candidate from an Exa people result. Prefers the structured person entity (name, location, work and
 * education history) and falls back to the highlight text ("# Name\n\nHeadline\n..."). An entity's facts ride
 * along, so confirming this candidate needs no enrichment call.
 */
export function exaCandidate(r: ExaResult): PersonCandidate {
  const text = (r.highlights ?? []).join('\n...\n') || r.summary || r.text || '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '...');
  const person = personOf(r);
  const name = (person?.name ?? r.title ?? lines[0]?.replace(/^#\s*/, '') ?? '').trim() || 'Unknown';
  const jobs = (person?.workHistory ?? []).filter((w) => w.title || w.company?.name);
  const current = jobs.find(isCurrentJob) ?? jobs[0];
  const role = current ? [current.title, current.company?.name].filter(Boolean).join(' at ') : undefined;
  const headlineLine = lines.find((l) => !l.startsWith('#') && l !== name && l.length < 160);
  const summary = [
    ...jobs
      .slice(0, 4)
      .map(
        (w) =>
          `${w.title ?? 'Role'}${w.company?.name ? ` at ${w.company.name}` : ''}${isCurrentJob(w) ? ' (current)' : ''}`,
      ),
    ...(person?.educationHistory ?? [])
      .slice(0, 2)
      .map((e) => [e.degree, e.institution?.name].filter(Boolean).join(', ')),
    text,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1500);
  const c: PersonCandidate = { provider: 'exa', name, url: r.url, summary };
  const headline = role || headlineLine?.replace(/^#+\s*/, '');
  if (headline) c.headline = headline;
  const loc = person?.location ?? text.match(/\b(?:Location|Based in|Lives in)[:\s]+([^\n.]{3,60})/i)?.[1];
  if (loc) c.location = loc.trim();
  if (person) {
    const facts = exaEntityFacts(person);
    if (facts.length) c.facts = facts;
  }
  return c;
}

export class ExaPeopleSearch implements PeopleSearch {
  readonly provider = 'exa';
  constructor(private readonly opts: ExaOptions = {}) {}

  async search(query: string, opts: { numResults: number }): Promise<PeopleSearchResult> {
    const { r, raw, costUsd, latencyMs } = await exa(
      this.opts,
      '/search',
      {
        query,
        category: 'people',
        numResults: Math.min(10, Math.max(1, opts.numResults)),
        contents: { highlights: { numSentences: 3, highlightsPerUrl: 3 } },
      },
      SEARCH_TIMEOUT,
    );
    return { candidates: r.results.map(exaCandidate), costUsd, latencyMs, raw };
  }

  /**
   * Reads the person's own link with `/contents`. A LinkedIn URL resolves to the same structured person entity as
   * search; any other page gives its title and text. A page Exa can't read (status `error`) gives no candidate.
   */
  async lookup(url: string): Promise<PeopleSearchResult> {
    const { r, raw, costUsd, latencyMs } = await exa(
      this.opts,
      '/contents',
      { urls: [url], text: { maxCharacters: 1500 } },
      CONTENTS_TIMEOUT,
    );
    return {
      // Exa echoes the URL as given; keep the person's exact link so it can be matched and opened.
      candidates: r.results.slice(0, 1).map((x) => ({ ...exaCandidate(x), url })),
      costUsd,
      latencyMs,
      raw,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Enrichment of the confirmed identity (PLAN §9.2 step 4): the output shape Parallel and Exa summaries share
// ---------------------------------------------------------------------------------------------------------------

/** What enrichment never collects, in every provider's instructions. */
export const ENRICH_EXCLUSIONS = 'Leave out health, religion, politics, sexuality and finances.';

export const ENRICH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    current_role: { type: 'string', description: 'Current job title, or empty if unknown' },
    current_employer: { type: 'string', description: 'Current employer, or empty if unknown' },
    employer_history: { type: 'array', items: { type: 'string' }, description: 'Previous employers' },
    education: { type: 'array', items: { type: 'string' }, description: 'Schools and degrees' },
    skills: { type: 'array', items: { type: 'string' }, description: 'Professional skills' },
    projects_and_writing: {
      type: 'array',
      items: { type: 'string' },
      description: 'Public projects, talks or writing',
    },
    interests: { type: 'array', items: { type: 'string' }, description: 'Stated interests or hobbies' },
    locations: { type: 'array', items: { type: 'string' }, description: 'Places they live or have lived' },
  },
  required: [
    'current_role',
    'current_employer',
    'employer_history',
    'education',
    'skills',
    'projects_and_writing',
    'interests',
    'locations',
  ],
  additionalProperties: false,
} as const;

/** ENRICH_OUTPUT_SCHEMA as a validator: absent fields are fine, wrongly typed ones are not. */
const text = z.string().nullable().optional();
const list = z.array(z.string()).nullable().optional();
export const EnrichOutput = z
  .object({
    current_role: text,
    current_employer: text,
    employer_history: list,
    education: list,
    skills: list,
    projects_and_writing: list,
    interests: list,
    locations: list,
  })
  .passthrough();
export type EnrichOutput = z.infer<typeof EnrichOutput>;

/** Parses a provider's JSON output (a string, possibly in a code fence, or an object) and validates its shape. */
export function parseEnrichOutput(content: unknown): EnrichOutput {
  const raw =
    typeof content === 'string'
      ? JSON.parse(
          content
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, ''),
        )
      : content;
  return EnrichOutput.parse(raw);
}

const FIELD_PREDICATES: Record<keyof typeof ENRICH_OUTPUT_SCHEMA.properties, string> = {
  current_role: 'jobTitle',
  current_employer: 'worksAt',
  employer_history: 'workedAt',
  education: 'educatedAt',
  skills: 'hasSkill',
  projects_and_writing: 'created',
  interests: 'hasInterest',
  locations: 'livesIn',
};

const CONFIDENCE: Record<string, number> = { low: 0.4, medium: 0.65, high: 0.85 };

/** Facts from a validated enrichment output. `source` gives each field's confidence and source URL. */
/**
 * At most this many facts per field. A live Exa summary of a personal site gave 34 facts, too many to review; the
 * first few of each list are the ones that matter.
 */
export const FACTS_PER_FIELD = 4;

export function schemaFacts(
  content: EnrichOutput,
  source: (field: string) => { confidence: number; url?: string | undefined },
): EnrichedFact[] {
  const facts: EnrichedFact[] = [];
  const current = content.current_employer?.trim().toLowerCase();
  for (const [field, predicate] of Object.entries(FIELD_PREDICATES)) {
    const v = content[field as keyof EnrichOutput];
    const values = (Array.isArray(v) ? v : [v])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      // The current employer again under past employers is one fact, not two.
      .filter((x) => field !== 'employer_history' || x.trim().toLowerCase() !== current);
    const { confidence, url } = source(field);
    for (const value of values.slice(0, FACTS_PER_FIELD)) {
      const f: EnrichedFact = { predicate, object: value.trim().slice(0, 200), confidence };
      if (url) f.sourceUrl = url;
      facts.push(f);
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------
// Parallel Task API: optional enrichment (ENRICH_PROVIDER=parallel)
// ---------------------------------------------------------------------------------------------------------------

const RunCreated = z.object({ run_id: z.string() }).passthrough();
const Citation = z.object({ url: z.string(), title: z.string().nullable().optional() }).passthrough();
const RunResult = z
  .object({
    output: z
      .object({
        type: z.string().optional(),
        content: z.unknown(),
        basis: z
          .array(
            z
              .object({
                field: z.string(),
                citations: z.array(Citation).default([]),
                confidence: z.string().nullable().optional(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough(),
  })
  .passthrough();

export function parallelFacts(result: z.infer<typeof RunResult>): EnrichedFact[] {
  const basis = new Map(result.output.basis.map((b) => [b.field, b]));
  return schemaFacts(parseEnrichOutput(result.output.content), (field) => {
    const b = basis.get(field);
    return {
      confidence: CONFIDENCE[(b?.confidence ?? 'medium').toLowerCase()] ?? 0.6,
      url: b?.citations[0]?.url,
    };
  });
}

export interface ParallelOptions extends HttpOptions {
  apiKey?: string;
  baseUrl?: string;
  processor?: string;
}

export class ParallelEnricher implements Enricher {
  readonly provider = 'parallel';
  constructor(private readonly opts: ParallelOptions = {}) {}

  enrich(subject: Parameters<Enricher['enrich']>[0], run: ProviderCallRunner): Promise<EnrichmentResult> {
    // One task: its create and result requests are one billed run.
    return run('parallel:task', subject, async () => {
      const started = Date.now();
      const base = this.opts.baseUrl ?? 'https://api.parallel.ai';
      const headers = authHeader('x-api-key', this.opts.apiKey);
      const { json: created } = await requestJson(
        { timeoutMs: 20_000, ...this.opts },
        `${base}/v1/tasks/runs`,
        {
          headers,
          body: {
            processor: this.opts.processor ?? 'base',
            input: {
              ...subject,
              instruction: `Find public professional information about this exact person, using the confirmed profile URL. ${ENRICH_EXCLUSIONS}`,
            },
            task_spec: { output_schema: { type: 'json', json_schema: ENRICH_OUTPUT_SCHEMA } },
          },
        },
      );
      const { run_id } = RunCreated.parse(created);
      const { json } = await requestJson(
        { timeoutMs: 180_000, retries: 1, ...this.opts },
        `${base}/v1/tasks/runs/${encodeURIComponent(run_id)}/result?timeout=170`,
        { method: 'GET', headers },
      );
      const r = RunResult.parse(json);
      // Parallel prices by processor and does not return a per-run cost; recorded as 0 (see ADR-0009).
      return { facts: parallelFacts(r), costUsd: 0, latencyMs: Date.now() - started, raw: json };
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Exa enrichment (the default; ADR-0034)
// ---------------------------------------------------------------------------------------------------------------

export class ExaEnricher implements Enricher {
  readonly provider = 'exa';
  /** Search candidates carry their entity's facts, so a candidate from search is confirmed without a call. */
  readonly usesSearchFacts = true;
  constructor(private readonly opts: ExaOptions = {}) {}

  /**
   * Reads the confirmed profile with `/contents` ($0.001, well under a second). A person entity maps to facts
   * directly. Any other readable page (a personal site) gets one more call: an Exa schema summary with the fields
   * Parallel would return ($0.001, a few seconds). Each call is logged on its own (PLAN §3.5).
   */
  async enrich(
    subject: Parameters<Enricher['enrich']>[0],
    run: ProviderCallRunner,
  ): Promise<EnrichmentResult> {
    const started = Date.now();
    const url = subject.url;
    const page = await run('exa:contents', { urls: [url] }, () =>
      exa(this.opts, '/contents', { urls: [url], text: { maxCharacters: 500 } }, CONTENTS_TIMEOUT),
    );
    const done = (facts: EnrichedFact[], costUsd: number, raw: unknown): EnrichmentResult => ({
      facts,
      costUsd,
      latencyMs: Date.now() - started,
      raw,
    });
    const result = page.r.results[0];
    if (!result) return done([], page.costUsd, page.raw); // Exa couldn't read the page: nothing to summarize
    const person = personOf(result);
    if (person) return done(exaEntityFacts(person, url), page.costUsd, page.raw);
    // A LinkedIn page without an entity: a summary of its text lists noise as skills (ADR-0034), so stop here.
    if (profileKey(url).startsWith('linkedin.com/')) return done([], page.costUsd, page.raw);

    const summary = await run('exa:summary', { urls: [url] }, async () => {
      const out = await exa(
        this.opts,
        '/contents',
        {
          urls: [url],
          summary: {
            query: `Public professional information about this person. ${ENRICH_EXCLUSIONS}`,
            schema: ENRICH_OUTPUT_SCHEMA,
          },
        },
        SUMMARY_TIMEOUT,
      );
      const text = out.r.results[0]?.summary;
      // Validated here, so a summary of the wrong shape is logged as a failed call.
      return { ...out, content: text ? parseEnrichOutput(text) : null };
    });
    const facts = summary.content
      ? schemaFacts(summary.content, () => ({ confidence: EXTRACTED_CONFIDENCE, url }))
      : [];
    return done(facts, page.costUsd + summary.costUsd, { contents: page.raw, summary: summary.raw });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Perplexity search: optional fallback for candidate discovery.
// ---------------------------------------------------------------------------------------------------------------

const PplxResponse = z
  .object({
    results: z.array(
      z.object({ title: z.string(), url: z.string(), snippet: z.string().optional() }).passthrough(),
    ),
  })
  .passthrough();

export class PerplexityPeopleSearch implements PeopleSearch {
  readonly provider = 'perplexity';
  constructor(private readonly opts: ExaOptions = {}) {}

  async search(query: string, opts: { numResults: number }): Promise<PeopleSearchResult> {
    const started = Date.now();
    const { json } = await requestJson(
      { timeoutMs: 20_000, ...this.opts },
      `${this.opts.baseUrl ?? 'https://api.perplexity.ai'}/search`,
      {
        headers: authHeader('authorization', this.opts.apiKey, 'Bearer '),
        body: { query: `${query} profile`, max_results: Math.min(10, opts.numResults) },
      },
    );
    const r = PplxResponse.parse(json);
    return {
      candidates: r.results.map((x) => ({
        provider: 'perplexity',
        name: x.title.split(/[-|–]/)[0]!.trim(),
        headline: x.title,
        url: x.url,
        summary: x.snippet ?? '',
      })),
      costUsd: 0,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }
}
