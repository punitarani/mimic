import { z } from 'zod';
import type { MimicJson } from './engine/artifact';
import type { CallContext, Gateway } from './gateway';
import { sha256Hex } from './hash';
import { type CertaintyTier, certaintyTier, facetReading, predicateLabel } from './labels';
import { parseJsonLoose } from './predictors';
import { PROMPTS } from './prompts';
import type { Facet } from './types';

/**
 * SOUL.md (ADR-0035): a portable Markdown portrait that any agent can read to represent the person. It is a view of
 * the mimic's current evidence and derived data, plus an optional LLM-written draft (`persona.v1`) and the person's
 * curation. Evidence stays the source of truth (PLAN §3.3): drafts are derived and versioned, and curation only
 * filters and rewords what goes into the file. Nothing here feeds back into states or predictions.
 */

export const SOUL_PROMPT_VERSION = 'persona.v1';
/** Fewer answers than this can't support cited statements. */
export const SOUL_MIN_ANSWERS = 5;
/** Answers sent to the writer, the most recent when over the cap. */
export const SOUL_MAX_ANSWERS = 300;
/** Scored answers needed before the file calls itself a strong prior. */
export const STRONG_MIN_SCORED = 20;
/** Below this certainty, or with no direct evidence, a facet goes under "Not known yet". */
export const KNOWN_MIN_CONFIDENCE = 0.4;
const MAX_PER_SECTION = 6;
const WHY_CHARS = 300;

export const STATEMENT_SECTIONS = [
  'decision_style',
  'principles',
  'tradeoffs',
  'values',
  'beliefs',
  'biases',
  'social',
] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

export const SOUL_SECTIONS = [
  'guide',
  'own_words',
  'summary',
  ...STATEMENT_SECTIONS,
  'background',
  'tendencies',
  'patterns',
  'unknowns',
  'record',
] as const;
export const SoulSectionId = z.enum(SOUL_SECTIONS);
export type SoulSectionId = z.infer<typeof SoulSectionId>;

const SECTION_META: Record<SoulSectionId, { title: string; about: string }> = {
  guide: { title: 'How to use this file', about: 'Instructions for the agent reading the file.' },
  own_words: {
    title: 'In their own words',
    about: 'What you write yourself. It overrides anything inferred.',
  },
  summary: { title: 'Summary', about: 'How you think and decide, in a few sentences.' },
  decision_style: { title: 'How they decide', about: 'Pace, information, other people, gut or analysis.' },
  principles: { title: 'Rules of thumb', about: 'The if-then patterns in your choices.' },
  tradeoffs: { title: 'Tradeoffs they make', about: 'What you give up, and for what.' },
  values: { title: 'What they value', about: 'What you care about and protect.' },
  beliefs: { title: 'Beliefs and opinions', about: 'Views your answers show.' },
  biases: { title: 'Biases and blind spots', about: 'Systematic tendencies, and where they show up.' },
  social: { title: 'How they come across', about: 'How you deal and communicate with others.' },
  background: { title: 'Background', about: 'Where you are, what you do, and sourced facts.' },
  tendencies: { title: 'Measured tendencies', about: 'Facet estimates from the decision model.' },
  patterns: { title: 'Patterns in their answers', about: 'Cited insights from reflection.' },
  unknowns: { title: 'Not known yet', about: 'Facets without enough evidence, so agents don’t guess.' },
  record: { title: 'Decision record', about: 'Your real answers, quoted as evidence.' },
};

/**
 * What a persona is built from: the mimic's current data, the same shape as the matching `mimic.json` fields. Built
 * live rather than from a snapshot, so a removed fact leaves the file at once and viewing never writes a snapshot.
 */
export interface SoulSource {
  asOf: number;
  subject: MimicJson['subject'];
  /** Active facts only. */
  facts: MimicJson['facts'];
  /** Facts the person removed: draft text that mentions one is left out of the file. */
  removedFacts: Array<{ predicate: string; object: string }>;
  evidence: MimicJson['evidence'];
  traits: MimicJson['traits'];
  insights: MimicJson['insights'];
  fidelity: MimicJson['fidelity'];
}

// ---------------------------------------------------------------------------------------------------------------
// Draft (LLM-written) and curation (the person's choices)
// ---------------------------------------------------------------------------------------------------------------

export const SoulStatement = z.object({
  section: z.enum(STATEMENT_SECTIONS),
  text: z.string().min(3).max(400),
  evidenceSeqs: z.array(z.number().int()),
  confidence: z.number().min(0).max(1),
});
export type SoulStatement = z.infer<typeof SoulStatement>;

export const SoulDraft = z.object({
  summary: z.string().max(1200),
  statements: z.array(SoulStatement),
});
export type SoulDraft = z.infer<typeof SoulDraft>;

const ItemKey = z.string().min(1).max(80);
export const SoulCuration = z.object({
  /** The name used in the file; null keeps the mimic's display name. */
  name: z.string().trim().max(120).nullable().default(null),
  /** Free Markdown written by the person. */
  notes: z.string().max(6000).default(''),
  disabled: z.array(SoulSectionId).default([]),
  hidden: z.array(ItemKey).max(2000).default([]),
  /** Rewordings of draft items (summary and statements), keyed by item key. */
  edits: z
    .record(ItemKey, z.string().trim().min(1).max(600))
    .refine((e) => Object.keys(e).length <= 500, 'too many edits')
    .default({}),
});
export type SoulCuration = z.infer<typeof SoulCuration>;
export const EMPTY_CURATION: SoulCuration = SoulCuration.parse({});

/** `PUT /soul`: the whole curation, with the client's revision (increasing per edit). */
export const SoulSave = z.object({ rev: z.number().int().nonnegative(), curation: SoulCuration });
export type SoulSave = z.infer<typeof SoulSave>;

/** One statement as the writer returned it; each is parsed on its own, so one bad item drops only itself. */
const RawStatement = z.object({
  section: z.string(),
  text: z.string(),
  evidenceSeqs: z.array(z.coerce.number().int()).catch([]),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});
const RawDraft = z.object({
  summary: z.string().catch(''),
  statements: z.array(z.unknown()).catch([]),
});

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The writer is told to cite in `evidenceSeqs` only; an inline "(#1, #2)" would duplicate the file's own citations.
 * Only bracketed references marked as citations are removed ("#3", "answer 3", "seq 3"), never bare numbers.
 */
const INLINE_CITE =
  /\s*[([]\s*(?:#|(?:answers?|seqs?|responses?)\s*#?)\d+(?:\s*(?:,|and|&|–|-|to)\s*#?\d+)*\s*[)\]]/gi;
export function stripInlineCites(s: string): string {
  return oneLine(s.replace(INLINE_CITE, '')).replace(/\s+([.,;:])/g, '$1');
}

/** Replaces the person's name (whole, and each part of 3+ letters) so it never reaches the writer. */
function nameRedactor(displayName: string): (s: string) => string {
  const parts = [displayName, ...displayName.split(/\s+/)]
    .map((p) => p.trim())
    .filter((p) => p.length >= 3)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return (s) => s;
  const re = new RegExp(`\\b(?:${parts.join('|')})\\b`, 'gi');
  return (s) => s.replace(re, '[name]');
}

/**
 * Rendered input for `persona.v1`, and the answer seqs it shows. Data minimization: no name (redacted anywhere it
 * appears, such as a search result's title), no `headline` facts, which are page titles, and no repeats, which the
 * file's decision record leaves out.
 */
export function soulWriterInput(src: SoulSource, facets: Facet[]): { text: string; shown: Set<number> } {
  const redact = nameRedactor(src.subject.displayName);
  const ctx = [`location: ${src.subject.location}`];
  if (src.subject.occupation) ctx.push(`occupation: ${src.subject.occupation}`);
  for (const f of src.facts) if (f.predicate !== 'headline') ctx.push(`${f.predicate}: ${oneLine(f.object)}`);
  const tendencies = traitLines(src, facets).map(
    (t) => `${t.facet.id}: ${t.label} (${t.facet.low} ↔ ${t.facet.high}; ${t.certainty} certainty)`,
  );
  const patterns = src.insights.map((i) => `- ${oneLine(i.text)} [${i.evidence.join(', ')}]`);
  const answers = recordEvidence(src).slice(-SOUL_MAX_ANSWERS);
  const lines = answers.map((e) => {
    const why = e.why ? ` (why: ${oneLine(e.why).slice(0, WHY_CHARS)})` : '';
    return `#${e.seq} ${oneLine(e.prompt)} [${e.options.join(' | ')}] → ${chosenLabel(e)}${why}`;
  });
  const text = [
    `CONTEXT:\n${ctx.join('\n')}`,
    `TENDENCIES:\n${tendencies.join('\n') || 'none yet'}`,
    `PATTERNS:\n${patterns.join('\n') || 'none yet'}`,
    `ANSWERS:\n${lines.join('\n')}`,
  ].join('\n\n');
  return { text: redact(text), shown: new Set(answers.map((e) => e.seq)) };
}

/**
 * Writes a draft with `persona.v1`. The citation guard matches the reflector's: a statement must cite at least one
 * answer the writer was shown, or it is dropped.
 */
export async function writeSoulDraft(
  gateway: Gateway,
  ctx: CallContext,
  input: { model: string; source: SoulSource; facets: Facet[] },
): Promise<{ draft: SoulDraft; dropped: number; modelSnapshot: string }> {
  const p = PROMPTS['persona.v1'];
  const { text, shown } = soulWriterInput(input.source, input.facets);
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: text },
    ],
    jsonSchema: { name: 'soul', schema: p.schema },
    reasoningEffort: 'medium',
    maxTokens: 16_000,
  });
  const parsed = RawDraft.safeParse(parseJsonLoose(res.content));
  if (!parsed.success) throw new Error('persona writer returned invalid JSON');
  const sections = new Set<string>(STATEMENT_SECTIONS);
  const perSection = new Map<string, number>();
  const seen = new Set<string>();
  const statements: SoulStatement[] = [];
  let dropped = 0;
  for (const raw of parsed.data.statements) {
    const r = RawStatement.safeParse(raw);
    if (!r.success) {
      dropped++;
      continue;
    }
    const s = r.data;
    const stmt = stripInlineCites(s.text).slice(0, 400);
    const cites = [...new Set(s.evidenceSeqs.filter((x) => shown.has(x)))].sort((a, b) => a - b);
    const n = perSection.get(s.section) ?? 0;
    if (!sections.has(s.section) || stmt.length < 3 || !cites.length || n >= MAX_PER_SECTION) {
      dropped++;
      continue;
    }
    if (seen.has(`${s.section}|${stmt}`)) continue;
    seen.add(`${s.section}|${stmt}`);
    perSection.set(s.section, n + 1);
    statements.push(
      SoulStatement.parse({
        section: s.section,
        text: stmt,
        evidenceSeqs: cites,
        confidence: s.confidence,
      }),
    );
  }
  const draft = SoulDraft.parse({
    summary: stripInlineCites(parsed.data.summary).slice(0, 1200),
    statements,
  });
  return { draft, dropped, modelSnapshot: res.modelSnapshot };
}

// ---------------------------------------------------------------------------------------------------------------
// The view (for curation) and the file
// ---------------------------------------------------------------------------------------------------------------

export interface SoulItem {
  key: string;
  /** The text before any edit by the person. */
  text: string;
  /** Secondary text: sources, poles and certainty. */
  detail: string | null;
  cites: number[];
  editable: boolean;
  /** Statements resting on one answer, or that the writer was unsure of. */
  tentative?: boolean;
  /** Tendencies: the facet group. */
  group?: string;
  /** Decision record: what was asked and chosen. */
  answer?: { options: string[]; chosen: string; why: string | null };
}

export interface SoulSection {
  id: SoulSectionId;
  title: string;
  about: string;
  items: SoulItem[];
}

export interface SoulDraftMeta {
  id: string;
  createdAt: number;
  seqUpTo: number;
  modelSnapshot: string;
  promptVersion: string;
}

export interface SoulInput {
  source: SoulSource;
  facets: Facet[];
  draft: (SoulDraftMeta & { draft: SoulDraft }) | null;
  curation: SoulCuration;
  rev?: number;
}

export interface SoulView {
  name: string;
  sections: SoulSection[];
  markdown: string;
  source: { asOf: number; answers: number };
  /** `answers`: answers the draft was written from; `newAnswers`: answered since. */
  draft: (SoulDraftMeta & { answers: number; newAnswers: number }) | null;
  /** Answers needed before a draft can be written. */
  minAnswers: number;
  curation: SoulCuration;
  /** Revision of the stored curation (0 when none is stored). */
  rev: number;
}

const short = (s: string) => sha256Hex(s).slice(0, 12);
/**
 * Curation keys. Draft items hash their content, so a rewrite that changes one drops its edit; the rest name stable
 * things (a fact, a facet, an answer), so hiding them survives rewrites and new answers.
 */
export const soulKey = {
  summary: (text: string) => `summary:${short(text)}`,
  statement: (s: Pick<SoulStatement, 'section' | 'text'>) => `st:${short(`${s.section}|${s.text}`)}`,
  identity: (field: 'location' | 'occupation') => `id:${field}`,
  fact: (f: { predicate: string; object: string }) => `fact:${short(`${f.predicate}|${f.object}`)}`,
  trait: (facetId: string) => `trait:${facetId}`,
  insight: (text: string) => `ins:${short(text)}`,
  record: (seq: number) => `ex:${seq}`,
};
const isDraftKey = (k: string) => k.startsWith('st:') || k.startsWith('summary:');

interface TraitLine {
  facet: Facet;
  label: string;
  certainty: CertaintyTier;
  known: boolean;
}

/** One line per facet with an estimate, preferring the decision model's read over psychometric scoring. */
function traitLines(src: SoulSource, facets: Facet[]): TraitLine[] {
  const best = new Map<string, MimicJson['traits'][number]>();
  for (const t of src.traits) {
    const cur = best.get(t.facet);
    if (!cur || (t.method === 'jev' && cur.method !== 'jev')) best.set(t.facet, t);
  }
  const out: TraitLine[] = [];
  for (const f of facets) {
    const t = best.get(f.id);
    if (!t) continue;
    out.push({
      facet: f,
      label: facetReading(f.labels, t.mean),
      certainty: certaintyTier(t.confidence),
      known: t.n > 0 && t.confidence >= KNOWN_MIN_CONFIDENCE,
    });
  }
  return out;
}

/** Repeats re-ask an earlier prompt to measure consistency; the record keeps the first time it was answered. */
function recordEvidence(src: SoulSource): MimicJson['evidence'] {
  return src.evidence.filter((e) => e.kind !== 'repeat');
}

function chosenLabel(e: MimicJson['evidence'][number]): string {
  return e.options[e.optionKeys.indexOf(e.answer)] ?? e.answer;
}

const SOURCES: Record<MimicJson['facts'][number]['source'], string> = {
  intake: 'stated by them',
  search: 'web search',
  answer: 'from their answers',
  reflection: 'inferred from their answers',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Draft text mentioning a fact the person removed stays out of the file (PLAN §15: every fact can be removed). */
function mentionsRemoved(src: SoulSource): (text: string) => boolean {
  const objects = src.removedFacts.map((f) => f.object.trim().toLowerCase()).filter((o) => o.length >= 3);
  return (text) => {
    const t = text.toLowerCase();
    return objects.some((o) => t.includes(o));
  };
}

/** Builds the curation view and the Markdown from the same items, so the preview is exactly the file. */
export function buildSoul(input: SoulInput): SoulView {
  const { source: src, facets, draft, curation } = input;
  const name = curation.name?.trim() || src.subject.displayName;
  const items = new Map<SoulSectionId, SoulItem[]>(SOUL_SECTIONS.map((s) => [s, []]));
  const push = (s: SoulSectionId, item: SoulItem) => items.get(s)!.push(item);

  if (draft) {
    const removed = mentionsRemoved(src);
    const summary = draft.draft.summary;
    if (summary && !removed(summary))
      push('summary', {
        key: soulKey.summary(summary),
        text: summary,
        detail: null,
        cites: [],
        editable: true,
      });
    for (const st of draft.draft.statements) {
      if (removed(st.text)) continue;
      push(st.section, {
        key: soulKey.statement(st),
        text: st.text,
        detail: null,
        cites: st.evidenceSeqs,
        editable: true,
        tentative: st.confidence < 0.5 || st.evidenceSeqs.length < 2,
      });
    }
  }

  if (src.subject.occupation)
    push('background', {
      key: soulKey.identity('occupation'),
      text: src.subject.occupation,
      detail: null,
      cites: [],
      editable: false,
    });
  if (src.subject.location)
    push('background', {
      key: soulKey.identity('location'),
      text: `Based in ${src.subject.location}`,
      detail: null,
      cites: [],
      editable: false,
    });
  const factSeen = new Set<string>();
  for (const f of src.facts) {
    const key = soulKey.fact(f);
    if (factSeen.has(key)) continue;
    factSeen.add(key);
    push('background', {
      key,
      text: `${predicateLabel(f.predicate)}: ${oneLine(f.object)}`,
      detail: f.url ? `${SOURCES[f.source]}, ${f.url}` : SOURCES[f.source],
      cites: [],
      editable: false,
    });
  }

  const traits = traitLines(src, facets);
  for (const t of traits.filter((x) => x.known)) {
    push('tendencies', {
      key: soulKey.trait(t.facet.id),
      text: `${capitalize(t.facet.name)}: ${t.label}`,
      detail: `${t.facet.low} ↔ ${t.facet.high}; ${t.certainty} certainty`,
      cites: [],
      editable: false,
      group: t.facet.group,
    });
  }
  const knownIds = new Set(traits.filter((x) => x.known).map((x) => x.facet.id));
  const unknown = facets.filter((f) => !knownIds.has(f.id));
  if (unknown.length)
    push('unknowns', {
      key: 'unknowns',
      text: unknown.map((f) => f.name.toLowerCase()).join(', '),
      detail: null,
      cites: [],
      editable: false,
    });

  for (const i of src.insights) {
    push('patterns', {
      key: soulKey.insight(i.text),
      text: oneLine(i.text),
      detail: null,
      cites: [...i.evidence].sort((a, b) => a - b),
      editable: false,
    });
  }

  for (const e of recordEvidence(src)) {
    push('record', {
      key: soulKey.record(e.seq),
      text: oneLine(e.prompt),
      detail: null,
      cites: [e.seq],
      editable: false,
      answer: { options: e.options, chosen: chosenLabel(e), why: e.why ? oneLine(e.why) : null },
    });
  }

  const sections: SoulSection[] = SOUL_SECTIONS.map((id) => ({
    id,
    ...SECTION_META[id],
    items: items.get(id)!,
  }));
  let draftMeta: SoulView['draft'] = null;
  if (draft) {
    const { draft: _body, ...meta } = draft;
    const within = src.evidence.filter((e) => e.seq <= draft.seqUpTo).length;
    draftMeta = { ...meta, answers: within, newAnswers: src.evidence.length - within };
  }
  return {
    name,
    sections,
    markdown: renderPersonaMarkdown({ name, src, sections, curation }),
    source: { asOf: src.asOf, answers: src.evidence.length },
    draft: draftMeta,
    minAnswers: SOUL_MIN_ANSWERS,
    curation,
    rev: input.rev ?? 0,
  };
}

function renderPersonaMarkdown(args: {
  name: string;
  src: SoulSource;
  sections: SoulSection[];
  curation: SoulCuration;
}): string {
  const { name, src, sections, curation } = args;
  const off = new Set<string>(curation.disabled);
  const hidden = new Set(curation.hidden);
  const on = (id: SoulSectionId) => !off.has(id);
  const visible = (id: SoulSectionId) =>
    on(id) ? sections.find((s) => s.id === id)!.items.filter((i) => !hidden.has(i.key)) : [];
  const textOf = (i: SoulItem) => oneLine(curation.edits[i.key] ?? i.text);

  // Citations point into the decision record, so they are shown only for answers that made it into the file.
  const recordSeqs = new Set(visible('record').flatMap((i) => i.cites));
  const cite = (seqs: number[]) => {
    const shown = seqs.filter((s) => recordSeqs.has(s));
    return shown.length ? ` [${shown.map((s) => `#${s}`).join(', ')}]` : '';
  };
  const first = firstName(name);
  const date = new Date(src.asOf).toISOString().slice(0, 10);
  const out: string[] = [`# Persona: ${name}`, ''];
  out.push(
    `A portrait of how ${name} thinks and makes decisions, built by Mimic from ${src.evidence.length} answers they gave about themselves, as of ${date}.`,
  );

  const section = (id: SoulSectionId, body: string[]) => {
    if (!body.length) return;
    out.push('', `## ${SECTION_META[id].title}`, '', ...body);
  };

  if (on('guide')) {
    const guide = [
      `- Use this file to represent ${first}: to predict their choices, argue their side, or act on their behalf. Reason the way ${first} would, not the way a typical person would.`,
    ];
    const ownWords = on('own_words') && !!curation.notes.trim();
    if (ownWords) guide.push(`- ${first}'s own words come first. They override anything inferred.`);
    guide.push(
      `- ${ownWords ? 'Everything else' : 'Everything here'} is inferred from their answers. Statements marked _tentative_ rest on little evidence.`,
    );
    if (recordSeqs.size)
      guide.push('- Citations like [#12] point to answers in the decision record at the end of the file.');
    guide.push(
      `- Where this file is silent or unsure, say so and ask. Don't invent experiences, facts or opinions for ${first}.`,
    );
    if (src.fidelity && src.fidelity.n > 0) {
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const f = src.fidelity;
      const base = f.accBaseline === null ? '' : ` (${pct(f.accBaseline)} from context alone)`;
      // "Strong prior" needs enough scored answers and a measured win over the context-only baseline.
      const strong = f.n >= STRONG_MIN_SCORED && f.accBaseline !== null && f.acc > f.accBaseline;
      guide.push(
        `- How far to trust it: the model behind this file predicted ${pct(f.acc)} of ${first}'s answers before seeing them${base}, over ${f.n} questions. ${
          strong
            ? 'Treat it as a strong prior, not a script.'
            : "It's early, so treat it as a rough sketch and lean on the decision record."
        }`,
      );
    }
    section('guide', guide);
  }

  // The person's Markdown is kept as written, with headings demoted so they stay inside this section.
  const notes = curation.notes.trim().replace(/^#{1,2}(?=\s)/gm, '###');
  if (on('own_words') && notes) section('own_words', [notes]);
  section(
    'summary',
    visible('summary').map((i) => textOf(i)),
  );
  for (const id of STATEMENT_SECTIONS) {
    section(
      id,
      visible(id).map((i) => `- ${textOf(i)}${i.tentative ? ' _(tentative)_' : ''}${cite(i.cites)}`),
    );
  }
  section(
    'background',
    visible('background').map((i) => `- ${i.text}${i.detail ? ` (${i.detail})` : ''}`),
  );

  const tendencies = visible('tendencies');
  if (tendencies.length) {
    const body = ['Estimated by a decision model from their answers. Each runs between the two poles shown.'];
    for (const g of [...new Set(tendencies.map((i) => i.group))]) {
      body.push('', `**${g}**`, '');
      for (const i of tendencies.filter((x) => x.group === g)) body.push(`- ${i.text} (${i.detail})`);
    }
    section('tendencies', body);
  }
  section(
    'patterns',
    visible('patterns').map((i) => `- ${i.text}${cite(i.cites)}`),
  );
  const unknowns = visible('unknowns');
  if (unknowns.length)
    section('unknowns', [
      `There isn't enough evidence yet on: ${unknowns[0]!.text}. Don't assume ${first} leans either way.`,
    ]);

  const record = visible('record');
  if (record.length) {
    const body = ['Real answers, in the order given. Quoted reasons are their own words.', ''];
    for (const i of record) {
      const a = i.answer!;
      body.push(
        `- **#${i.cites[0]}** ${i.text} _(${a.options.join(' · ')})_ → **${a.chosen}**${a.why ? `. Why: “${a.why}”` : ''}`,
      );
    }
    section('record', body);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Drops edits and hidden keys for draft items that are no longer in the latest draft (a rewrite replaced them). Keys
 * for stable things (facts, facets, answers, identity fields) are kept even when the item is missing for now, so an
 * item the person hid stays hidden when it comes back.
 */
export function pruneCuration(c: SoulCuration, draft: SoulDraft | null): SoulCuration {
  const current = new Set<string>();
  if (draft?.summary) current.add(soulKey.summary(draft.summary));
  for (const st of draft?.statements ?? []) current.add(soulKey.statement(st));
  const keep = (k: string) => !isDraftKey(k) || current.has(k);
  return {
    ...c,
    hidden: [...new Set(c.hidden.filter(keep))],
    edits: Object.fromEntries(Object.entries(c.edits).filter(([k]) => isDraftKey(k) && current.has(k))),
  };
}
