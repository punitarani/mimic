import { z } from 'zod';
import { expectedIndex, normalizeDist } from './distribution';
import type { CallContext, Gateway } from './gateway';
import { GATES, type Gate, gateFailures, gateQuestions, traitQuestion } from './jev';
import { MAX_PROMPT_WORDS } from './limits';
import type { ItemTemplate } from './ontology';
import { parseJsonLoose } from './predictors';
import { PROMPTS } from './prompts';
import { renderStateText, stateForProvider } from './state-builder';
import type {
  ChatMessage,
  Domain,
  Facet,
  Option,
  PersonState,
  QType,
  ReasoningEffort,
  TraitEstimate,
} from './types';

// ---------------------------------------------------------------------------------------------------------------
// Candidate generation (PLAN §9.4)
// ---------------------------------------------------------------------------------------------------------------

export interface DraftQuestion {
  type: QType;
  domain: Domain;
  prompt: string;
  options: Option[];
  facetIds: string[];
  rationale?: string;
}

const RawDraft = z.object({
  type: z.enum(['choice', 'noul', 'score']),
  domain: z.enum(['core', 'casual', 'professional']).catch('casual'),
  prompt: z.string().min(8).max(400),
  options: z.array(z.object({ key: z.string(), label: z.string().min(1).max(160) })),
  facetIds: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});

const HEDGE = /\b(it depends|depends on|not sure|n\/a|none of (the|these))\b/i;

export { MAX_PROMPT_WORDS };

/**
 * Schema gate: zod validation plus option rules by type (choice 2–5, noul yes/no, score exactly 5 ordered).
 * Returns a normalized draft or the reason it failed.
 */
export function validateDraft(
  raw: unknown,
  facetIds: ReadonlySet<string>,
): DraftQuestion | { error: string } {
  const p = RawDraft.safeParse(raw);
  if (!p.success) return { error: 'schema' };
  const d = p.data;
  const prompt = d.prompt.trim().replace(/\s+/g, ' ');
  if (prompt.split(' ').length > MAX_PROMPT_WORDS) return { error: 'too long' };
  const facets = [...new Set(d.facetIds.filter((f) => facetIds.has(f)))];
  if (!facets.length) return { error: 'no known facet' };
  const labels = d.options.map((o) => o.label.trim());
  if (labels.some((l) => HEDGE.test(l))) return { error: 'hedge option' };
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length)
    return { error: 'duplicate options' };

  let options: Option[];
  if (d.type === 'noul') {
    options = [
      { key: 'yes', label: 'Yes' },
      { key: 'no', label: 'No' },
    ];
  } else if (d.type === 'score') {
    if (labels.length !== 5) return { error: 'score needs 5 options' };
    options = labels.map((label, i) => ({ key: String(i), label }));
  } else {
    if (labels.length < 2 || labels.length > 5) return { error: 'choice needs 2–5 options' };
    options = labels.map((label, i) => ({ key: 'abcde'[i]!, label }));
  }
  const out: DraftQuestion = { type: d.type, domain: d.domain, prompt, options, facetIds: facets };
  if (d.rationale) out.rationale = d.rationale;
  return out;
}

export interface GenerateInput {
  model: string;
  reasoningEffort: ReasoningEffort;
  facets: Facet[];
  targets: string[];
  quota: Record<Domain, number>;
  identity: Record<string, unknown>;
  traitSummary: string;
  recentPrompts: string[];
  n: number;
}

export interface GenerateOutput {
  drafts: DraftQuestion[];
  rejected: Array<{ error: string }>;
}

function ontologyBlock(facets: Facet[]): string {
  return facets.map((f) => `${f.id} | ${f.name} | ${f.low} → ${f.high}`).join('\n');
}

export async function generateCandidates(
  gateway: Gateway,
  ctx: CallContext,
  input: GenerateInput,
): Promise<GenerateOutput> {
  const p = PROMPTS['gen.v1'];
  // Stable prefix first (system, ontology), variable task last, so provider prompt caching applies (PLAN §5).
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${p.system}\n\nONTOLOGY (id | name | low → high):\n${ontologyBlock(input.facets)}`,
    },
    {
      role: 'user',
      content: [
        `Target facets: ${input.targets.join(', ')}`,
        `Domain quota: ${JSON.stringify(input.quota)}`,
        `Person context: ${JSON.stringify(input.identity)}`,
        `Trait summary: ${input.traitSummary || 'none yet'}`,
        `Recently asked (don't repeat these):\n${input.recentPrompts.map((r) => `- ${r}`).join('\n') || '- none'}`,
        `Write ${input.n} questions.`,
      ].join('\n'),
    },
  ];
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages,
    jsonSchema: { name: 'questions', schema: p.schema },
    reasoningEffort: input.reasoningEffort,
    maxTokens: 12_000,
  });
  const parsed = parseJsonLoose(res.content) as { questions?: unknown[] } | unknown[] | undefined;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : [];
  const known = new Set(input.facets.map((f) => f.id));
  const drafts: DraftQuestion[] = [];
  const rejected: Array<{ error: string }> = [];
  for (const raw of list) {
    const v = validateDraft(raw, known);
    if ('error' in v) rejected.push(v);
    else drafts.push(v);
  }
  return { drafts, rejected };
}

export interface GateResult {
  passed: boolean;
  failures: Gate[];
  p: Record<Gate, number>;
}

/** Quality gates: one Jev request per candidate, all in parallel (PLAN §9.4, B.3). */
export async function runQualityGates(
  gateway: Gateway,
  ctx: CallContext,
  jevModel: string,
  drafts: DraftQuestion[],
): Promise<GateResult[]> {
  const questions = gateQuestions();
  return Promise.all(
    drafts.map(async (d) => {
      try {
        const res = await gateway.decide(ctx, {
          model: jevModel,
          state: { question: { prompt: d.prompt, type: d.type, options: d.options.map((o) => o.label) } },
          questions,
        });
        const p = Object.fromEntries(
          GATES.map((g) => {
            const a = res.answers[g];
            return [g, a?.type === 'noul' ? a.p : g === 'quick' ? 0 : 1];
          }),
        ) as Record<Gate, number>;
        const failures = gateFailures(p);
        return { passed: failures.length === 0, failures, p };
      } catch {
        const p = { ambiguous: 1, sensitive: 1, leading: 1, quick: 0 };
        return { passed: false, failures: [...GATES], p };
      }
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Traits (PLAN §9.8)
// ---------------------------------------------------------------------------------------------------------------

export function traitKey(facetId: string): string {
  return `t_${facetId}`;
}

export async function readTraits(
  gateway: Gateway,
  ctx: CallContext,
  jevModel: string,
  state: PersonState,
  facets: Facet[],
  seqUpTo: number,
  evidenceCounts: Map<string, number>,
): Promise<{ traits: TraitEstimate[]; modelSnapshot: string }> {
  const res = await gateway.decide(ctx, {
    model: jevModel,
    state: stateForProvider(state),
    questions: Object.fromEntries(facets.map((f) => [traitKey(f.id), traitQuestion(f)])),
  });
  const keys = ['0', '1', '2', '3', '4'];
  const traits: TraitEstimate[] = [];
  for (const f of facets) {
    const a = res.answers[traitKey(f.id)];
    if (a?.type !== 'score') continue;
    const dist = normalizeDist(a.probabilities, keys);
    traits.push({
      facetId: f.id,
      method: 'jev',
      seqUpTo,
      mean: expectedIndex(dist) / 4,
      dist,
      confidence: a.confidence ?? 0,
      nEvidence: evidenceCounts.get(f.id) ?? 0,
    });
  }
  return { traits, modelSnapshot: res.modelSnapshot };
}

/** Deterministic scoring of psychometric anchor items (Big Five markers), as a sanity check. */
export function psychometricTraits(
  answered: Array<{ seq: number; itemKey?: string | null; answer: string }>,
  items: ItemTemplate[],
): TraitEstimate[] {
  const byKey = new Map(items.filter((i) => i.psychometric).map((i) => [i.itemKey, i]));
  const out: TraitEstimate[] = [];
  for (const a of answered) {
    const item = a.itemKey ? byKey.get(a.itemKey) : undefined;
    if (!item?.psychometric) continue;
    const idx = Number(a.answer);
    const x = item.psychometric.reverse ? 4 - idx : idx;
    const dist = normalizeDist({ [String(x)]: 1 }, ['0', '1', '2', '3', '4']);
    out.push({
      facetId: item.psychometric.facetId,
      method: 'psychometric',
      seqUpTo: a.seq,
      mean: x / 4,
      dist,
      confidence: 0.3,
      nEvidence: 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reflection (PLAN §9.8)
// ---------------------------------------------------------------------------------------------------------------

export interface ReflectionDelta {
  insights: Array<{ text: string; facetIds: string[]; evidenceSeqs: number[]; confidence: number }>;
  facts: Array<{ predicate: string; object: string; evidenceSeqs: number[] }>;
  contradictions: Array<{ insightId: string; evidenceSeqs: number[] }>;
  dropped: number;
  modelSnapshot: string;
}

const ReflectionOut = z.object({
  insights: z
    .array(
      z.object({
        text: z.string().min(3).max(400),
        facetIds: z.array(z.string()).default([]),
        evidenceSeqs: z.array(z.number().int()).default([]),
        confidence: z.number().min(0).max(1).catch(0.5),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        predicate: z.string().max(40),
        object: z.string().min(1).max(200),
        evidenceSeqs: z.array(z.number().int()).default([]),
      }),
    )
    .default([]),
  contradictions: z
    .array(z.object({ insightId: z.string(), evidenceSeqs: z.array(z.number().int()).default([]) }))
    .default([]),
});

export async function reflect(
  gateway: Gateway,
  ctx: CallContext,
  input: {
    model: string;
    facets: Facet[];
    existing: Array<{ id: string; text: string; evidenceSeqs: number[] }>;
    newEvidence: PersonState['evidence'];
    earlierEvidence: PersonState['evidence'];
  },
): Promise<ReflectionDelta> {
  const p = PROMPTS['reflect.v1'];
  const fmt = (xs: PersonState['evidence']) =>
    xs
      .map(
        (e) => `#${e.seq} ${e.q} [${e.options.join(' | ')}] → ${e.answer}${e.why ? ` (why: ${e.why})` : ''}`,
      )
      .join('\n') || 'none';
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      {
        role: 'system',
        content: `${p.system}\n\nONTOLOGY facet IDs: ${input.facets.map((f) => f.id).join(', ')}`,
      },
      {
        role: 'user',
        content: `EXISTING INSIGHTS:\n${
          input.existing.map((i) => `${i.id}: ${i.text} [${i.evidenceSeqs.join(', ')}]`).join('\n') || 'none'
        }\n\nNEW EVIDENCE:\n${fmt(input.newEvidence)}\n\nRELEVANT EARLIER EVIDENCE:\n${fmt(input.earlierEvidence)}`,
      },
    ],
    jsonSchema: { name: 'reflection', schema: p.schema },
    reasoningEffort: 'low',
    maxTokens: 10_000,
  });
  const parsed = ReflectionOut.safeParse(parseJsonLoose(res.content));
  if (!parsed.success) throw new Error('reflector returned invalid JSON');
  const valid = new Set([...input.newEvidence, ...input.earlierEvidence].map((e) => e.seq));
  const known = new Set(input.facets.map((f) => f.id));
  const existingIds = new Set(input.existing.map((i) => i.id));
  let dropped = 0;
  // Citation guard: an insight must cite at least one real answer seq (guards against stereotyping).
  const insights = parsed.data.insights
    .map((i) => ({
      ...i,
      evidenceSeqs: [...new Set(i.evidenceSeqs.filter((s) => valid.has(s)))].sort((a, b) => a - b),
      facetIds: i.facetIds.filter((f) => known.has(f)),
    }))
    .filter((i) => {
      if (i.evidenceSeqs.length === 0) dropped++;
      return i.evidenceSeqs.length > 0;
    });
  const facts = parsed.data.facts
    .map((f) => ({ ...f, evidenceSeqs: f.evidenceSeqs.filter((s) => valid.has(s)) }))
    .filter((f) => f.evidenceSeqs.length > 0);
  const contradictions = parsed.data.contradictions.filter((c) => existingIds.has(c.insightId));
  return { insights, facts, contradictions, dropped, modelSnapshot: res.modelSnapshot };
}

// ---------------------------------------------------------------------------------------------------------------
// Persona hypotheses (BALD), occupation facets, playground
// ---------------------------------------------------------------------------------------------------------------

export async function generateHypotheses(
  gateway: Gateway,
  ctx: CallContext,
  input: { model: string; state: PersonState; lowFacets: string[]; k: number },
): Promise<string[]> {
  const p = PROMPTS['hyp.v1'];
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      { role: 'system', content: p.system.replace('{k}', String(input.k)) },
      {
        role: 'user',
        content: `STATE:\n${renderStateText(input.state)}\n\nLOW-CERTAINTY FACETS: ${input.lowFacets.join(', ')}\nK: ${input.k}`,
      },
    ],
    jsonSchema: { name: 'hypotheses', schema: p.schema },
    reasoningEffort: 'low',
    maxTokens: 10_000,
  });
  const parsed = parseJsonLoose(res.content) as { hypotheses?: Array<{ text?: unknown }> } | undefined;
  return (parsed?.hypotheses ?? [])
    .map((h) => (typeof h.text === 'string' ? h.text.trim() : ''))
    .filter((t) => t.length > 10)
    .slice(0, input.k);
}

const OccFacet = z.object({
  id: z.string(),
  name: z.string().min(2).max(60),
  low: z.string().min(2).max(80),
  high: z.string().min(2).max(80),
  labels: z.array(z.string().min(1).max(80)).length(5),
});

export async function generateOccupationFacets(
  gateway: Gateway,
  ctx: CallContext,
  input: { model: string; occupation: string; employer?: string | null },
): Promise<Facet[]> {
  const p = PROMPTS['occfacets.v1'];
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      { role: 'system', content: p.system },
      {
        role: 'user',
        content: `OCCUPATION: ${input.occupation}${input.employer ? `\nEMPLOYER: ${input.employer}` : ''}`,
      },
    ],
    jsonSchema: { name: 'facets', schema: p.schema },
    reasoningEffort: 'low',
    maxTokens: 6000,
  });
  const parsed = parseJsonLoose(res.content) as { facets?: unknown[] } | undefined;
  const out: Facet[] = [];
  for (const raw of parsed?.facets ?? []) {
    const f = OccFacet.safeParse(raw);
    if (!f.success) continue;
    const slug = f.data.id
      .toLowerCase()
      .replace(/^occ_/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    if (!slug || out.some((o) => o.id === `occ_${slug}`)) continue;
    out.push({
      id: `occ_${slug}`,
      group: 'Work',
      name: f.data.name,
      low: f.data.low,
      high: f.data.high,
      labels: f.data.labels as Facet['labels'],
      occupation: true,
    });
  }
  return out.slice(0, 5);
}

export async function scenarioToQuestion(
  gateway: Gateway,
  ctx: CallContext,
  input: { model: string; scenario: string },
): Promise<DraftQuestion> {
  const p = PROMPTS['ask.v1'];
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: `SCENARIO: ${input.scenario}` },
    ],
    jsonSchema: { name: 'question', schema: p.schema },
    reasoningEffort: 'low',
    maxTokens: 4000,
  });
  const raw = parseJsonLoose(res.content) as Record<string, unknown> | undefined;
  const v = validateDraft(
    { ...raw, domain: 'casual', facetIds: ['__playground'] },
    new Set(['__playground']),
  );
  if ('error' in v) throw new Error(`Could not turn the scenario into a question (${v.error})`);
  return { ...v, facetIds: [] };
}

export async function generateRationale(
  gateway: Gateway,
  ctx: CallContext,
  input: { model: string; state: PersonState; prompt: string; optionLabel: string },
): Promise<string | null> {
  const p = PROMPTS['rationale.v1'];
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      { role: 'system', content: p.system },
      {
        role: 'user',
        content: `STATE:\n${renderStateText(input.state)}\n\nQUESTION: ${input.prompt}\nPREDICTED OPTION: ${input.optionLabel}`,
      },
    ],
    jsonSchema: { name: 'rationale', schema: p.schema },
    reasoningEffort: 'low',
    maxTokens: 2000,
  });
  const parsed = parseJsonLoose(res.content) as { sentence?: unknown } | undefined;
  return typeof parsed?.sentence === 'string' ? parsed.sentence.slice(0, 300) : null;
}
