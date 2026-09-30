import type {
  EnrichedFact,
  Enricher,
  EnrichmentResult,
  PeopleSearch,
  PeopleSearchResult,
  PersonCandidate,
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
                dates: z.object({ to: z.string().nullable().optional() }).passthrough().nullable().optional(),
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

export interface ExaOptions extends HttpOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Builds a candidate from an Exa people result. Prefers the structured person entity (name, location, work and
 * education history) and falls back to the highlight text ("# Name\n\nHeadline\n...").
 */
export function exaCandidate(r: z.infer<typeof ExaResponse>['results'][number]): PersonCandidate {
  const text = (r.highlights ?? []).join('\n...\n') || r.summary || r.text || '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '...');
  const person = r.entities?.find((e) => e.type === 'person')?.properties;
  const name = (person?.name ?? r.title ?? lines[0]?.replace(/^#\s*/, '') ?? '').trim() || 'Unknown';
  const jobs = (person?.workHistory ?? []).filter((w) => w.title || w.company?.name);
  const current = jobs.find((w) => !w.dates?.to) ?? jobs[0];
  const role = current ? [current.title, current.company?.name].filter(Boolean).join(' at ') : undefined;
  const headlineLine = lines.find((l) => !l.startsWith('#') && l !== name && l.length < 160);
  const summary = [
    ...jobs
      .slice(0, 4)
      .map(
        (w) =>
          `${w.title ?? 'Role'}${w.company?.name ? ` at ${w.company.name}` : ''}${w.dates?.to ? '' : ' (current)'}`,
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
  return c;
}

export class ExaPeopleSearch implements PeopleSearch {
  readonly provider = 'exa';
  constructor(private readonly opts: ExaOptions = {}) {}

  async search(query: string, opts: { numResults: number }): Promise<PeopleSearchResult> {
    const started = Date.now();
    const { json } = await requestJson(
      { timeoutMs: 20_000, ...this.opts },
      `${this.opts.baseUrl ?? 'https://api.exa.ai'}/search`,
      {
        headers: authHeader('x-api-key', this.opts.apiKey),
        body: {
          query,
          category: 'people',
          numResults: Math.min(10, Math.max(1, opts.numResults)),
          contents: { highlights: { numSentences: 3, highlightsPerUrl: 3 } },
        },
      },
    );
    const r = ExaResponse.parse(json);
    return {
      candidates: r.results.map(exaCandidate),
      costUsd: r.costDollars?.total ?? 0,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }

  /**
   * Reads the person's own link with `/contents`. A LinkedIn URL resolves to the same structured person entity as
   * search; any other page gives its title and text. A page Exa can't read (status `error`) gives no candidate.
   */
  async lookup(url: string): Promise<PeopleSearchResult> {
    const started = Date.now();
    const { json } = await requestJson(
      { timeoutMs: 20_000, ...this.opts },
      `${this.opts.baseUrl ?? 'https://api.exa.ai'}/contents`,
      {
        headers: authHeader('x-api-key', this.opts.apiKey),
        body: { urls: [url], text: { maxCharacters: 1500 } },
      },
    );
    const r = ExaResponse.parse(json);
    return {
      // Exa echoes the URL as given; keep the person's exact link so it can be matched and opened.
      candidates: r.results.slice(0, 1).map((x) => ({ ...exaCandidate(x), url })),
      costUsd: r.costDollars?.total ?? 0,
      latencyMs: Date.now() - started,
      raw: json,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parallel Task API: structured enrichment of the confirmed identity (PLAN §9.2 step 4)
// ---------------------------------------------------------------------------------------------------------------

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

const FIELD_PREDICATES: Record<string, string> = {
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

/**
 * Facts from an object shaped like ENRICH_OUTPUT_SCHEMA (a Parallel task output or an Exa schema summary). `source`
 * gives each field's confidence and source URL.
 */
export function schemaFacts(
  content: unknown,
  source: (field: string) => { confidence: number; url?: string | undefined },
): EnrichedFact[] {
  if (!content || typeof content !== 'object') return [];
  const facts: EnrichedFact[] = [];
  for (const [field, predicate] of Object.entries(FIELD_PREDICATES)) {
    const v = (content as Record<string, unknown>)[field];
    const values = (Array.isArray(v) ? v : [v]).filter(
      (x): x is string => typeof x === 'string' && x.trim().length > 0,
    );
    const { confidence, url } = source(field);
    for (const value of values.slice(0, 8)) {
      const f: EnrichedFact = { predicate, object: value.trim().slice(0, 200), confidence };
      if (url) f.sourceUrl = url;
      facts.push(f);
    }
  }
  return facts;
}

export function parallelFacts(result: z.infer<typeof RunResult>): EnrichedFact[] {
  const content: unknown =
    typeof result.output.content === 'string' ? JSON.parse(result.output.content) : result.output.content;
  const basis = new Map(result.output.basis.map((b) => [b.field, b]));
  return schemaFacts(content, (field) => {
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

  async enrich(subject: Parameters<Enricher['enrich']>[0]): Promise<EnrichmentResult> {
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
            instruction:
              'Find public professional information about this exact person, using the confirmed profile URL. Do not include health, religion, politics, sexuality or finances.',
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
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Exa enrichment: facts from the confirmed profile (ADR-0034). The default: a LinkedIn profile resolves to Exa's
// structured person entity for $0.001 in well under a second, where a Parallel task costs $0.01 and takes tens of
// seconds.
// ---------------------------------------------------------------------------------------------------------------

type ExaPerson = NonNullable<z.infer<typeof ExaEntity>['properties']>;

/** Structured data from a professional profile: reliable, so facts from it rank above extracted ones. */
const ENTITY_CONFIDENCE = 0.85;
/** Fields an LLM pulled out of a page's text. */
const EXTRACTED_CONFIDENCE = 0.6;

/**
 * Facts from an Exa person entity: the current role and employers, past employers, education and location. Skills
 * and interests aren't in the entity; extracting them from profile text was noisy in live checks, so they are left
 * to the person's answers.
 */
export function exaEntityFacts(person: ExaPerson, url: string): EnrichedFact[] {
  const facts: EnrichedFact[] = [];
  const add = (predicate: string, object: string | null | undefined) => {
    const v = object?.trim();
    if (!v) return;
    if (facts.some((f) => f.predicate === predicate && f.object.toLowerCase() === v.toLowerCase())) return;
    facts.push({ predicate, object: v.slice(0, 200), confidence: ENTITY_CONFIDENCE, sourceUrl: url });
  };
  const jobs = (person.workHistory ?? []).filter((w) => w.title || w.company?.name);
  const current = jobs.filter((w) => !w.dates?.to);
  add('jobTitle', current[0]?.title);
  for (const w of current.slice(0, 3)) add('worksAt', w.company?.name);
  const currentEmployers = new Set(current.map((w) => w.company?.name?.trim().toLowerCase()));
  for (const w of jobs.filter((j) => j.dates?.to).slice(0, 8)) {
    if (!currentEmployers.has(w.company?.name?.trim().toLowerCase())) add('workedAt', w.company?.name);
  }
  for (const e of (person.educationHistory ?? []).slice(0, 4)) {
    const school = e.institution?.name?.trim();
    add('educatedAt', school && e.degree ? `${school} (${e.degree.trim()})` : school);
  }
  add('livesIn', person.location);
  return facts;
}

const ENRICH_SUMMARY_QUERY =
  'Public professional information about this person. Leave out health, religion, politics, sexuality and finances.';

export class ExaEnricher implements Enricher {
  readonly provider = 'exa';
  constructor(private readonly opts: ExaOptions = {}) {}

  /**
   * Reads the confirmed profile with `/contents`. A professional profile has a person entity, mapped to facts
   * directly. Any other page (a personal site) gets one more call: an Exa schema summary with the fields Parallel
   * would return ($0.001, a few seconds).
   */
  async enrich(subject: Parameters<Enricher['enrich']>[0]): Promise<EnrichmentResult> {
    const started = Date.now();
    const contents = (body: Record<string, unknown>) =>
      requestJson(
        { timeoutMs: 20_000, ...this.opts },
        `${this.opts.baseUrl ?? 'https://api.exa.ai'}/contents`,
        {
          headers: authHeader('x-api-key', this.opts.apiKey),
          body: { urls: [subject.url], ...body },
        },
      ).then(({ json }) => ({ json, r: ExaResponse.parse(json) }));

    const page = await contents({ text: { maxCharacters: 500 } });
    const person = page.r.results[0]?.entities?.find((e) => e.type === 'person')?.properties;
    if (person) {
      return {
        facts: exaEntityFacts(person, subject.url),
        costUsd: page.r.costDollars?.total ?? 0,
        latencyMs: Date.now() - started,
        raw: page.json,
      };
    }
    const summary = await contents({
      summary: { query: ENRICH_SUMMARY_QUERY, schema: ENRICH_OUTPUT_SCHEMA },
    });
    let content: unknown = null;
    try {
      content = JSON.parse(summary.r.results[0]?.summary ?? 'null');
    } catch {
      // A summary that isn't JSON gives no facts; the person still reviews the candidate's own facts.
    }
    return {
      facts: schemaFacts(content, () => ({ confidence: EXTRACTED_CONFIDENCE, url: subject.url })),
      costUsd: (page.r.costDollars?.total ?? 0) + (summary.r.costDollars?.total ?? 0),
      latencyMs: Date.now() - started,
      raw: { contents: page.json, summary: summary.json },
    };
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
