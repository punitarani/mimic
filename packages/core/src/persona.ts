import { z } from 'zod';
import type { MimicJson } from './engine/artifact';
import type { CallContext, Gateway } from './gateway';
import { sha256Hex } from './hash';
import { parseJsonLoose } from './predictors';
import { PROMPTS } from './prompts';
import type { Facet } from './types';

/**
 * Persona.md (ADR-0027): a portable Markdown portrait that any agent can read to represent the person. It is a view of
 * the latest `mimic.json` snapshot, plus an optional LLM-written draft (`persona.v1`) and the person's curation.
 * Evidence stays the source of truth (PLAN §3.3): drafts are derived and versioned, and curation only filters and
 * rewords what goes into the file. Nothing here feeds back into states or predictions.
 */

export const PERSONA_PROMPT_VERSION = 'persona.v1';
/** Fewer answers than this can't support cited statements. */
export const PERSONA_MIN_ANSWERS = 5;
/** Answers sent to the writer, most recent first when over the cap. */
export const PERSONA_MAX_ANSWERS = 300;
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

export const PERSONA_SECTIONS = [
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
export const PersonaSectionId = z.enum(PERSONA_SECTIONS);
export type PersonaSectionId = z.infer<typeof PersonaSectionId>;

const SECTION_META: Record<PersonaSectionId, { title: string; about: string }> = {
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

// ---------------------------------------------------------------------------------------------------------------
// Draft (LLM-written) and curation (the person's choices)
// ---------------------------------------------------------------------------------------------------------------

export const PersonaStatement = z.object({
  section: z.enum(STATEMENT_SECTIONS),
  text: z.string().min(3).max(400),
  evidenceSeqs: z.array(z.number().int()),
  confidence: z.number().min(0).max(1),
});
export type PersonaStatement = z.infer<typeof PersonaStatement>;

export const PersonaDraft = z.object({
  summary: z.string().max(1200),
  statements: z.array(PersonaStatement),
});
export type PersonaDraft = z.infer<typeof PersonaDraft>;

const ItemKey = z.string().min(1).max(80);
export const PersonaCuration = z.object({
  /** The name used in the file; null keeps the mimic's display name. */
  name: z.string().trim().max(120).nullable().default(null),
  /** Free Markdown written by the person. */
  notes: z.string().max(6000).default(''),
  disabled: z.array(PersonaSectionId).default([]),
  hidden: z.array(ItemKey).max(2000).default([]),
  /** Rewordings of draft items (summary and statements), keyed by item key. */
  edits: z
    .record(ItemKey, z.string().trim().min(1).max(600))
    .refine((e) => Object.keys(e).length <= 500, 'too many edits')
    .default({}),
});
export type PersonaCuration = z.infer<typeof PersonaCuration>;
export const EMPTY_CURATION: PersonaCuration = PersonaCuration.parse({});

const RawDraft = z.object({
  summary: z.string().catch(''),
  statements: z
    .array(
      z.object({
        section: z.string(),
        text: z.string(),
        evidenceSeqs: z.array(z.number().int()).catch([]),
        confidence: z.number().min(0).max(1).catch(0.5),
      }),
    )
    .catch([]),
});

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The writer is told to cite in `evidenceSeqs` only; inline "(#1, #2)" references would duplicate the file's own. */
export function stripInlineCites(s: string): string {
  return oneLine(s.replace(/\s*[([]\s*(?:answers?\s*)?#?\d+(?:\s*(?:,|and|&)\s*#?\d+)*\s*[)\]]/gi, ''));
}

/** Rendered input for `persona.v1`. No name: the writer refers to the person as "they" (data minimization). */
export function personaWriterInput(doc: MimicJson, facets: Facet[]): string {
  const ctx = [`location: ${doc.subject.location}`];
  if (doc.subject.occupation) ctx.push(`occupation: ${doc.subject.occupation}`);
  for (const f of doc.facts) ctx.push(`${f.predicate}: ${oneLine(f.object)}`);
  const tendencies = traitLines(doc, facets).map(
    (t) => `${t.facet.id}: ${t.label} (${t.facet.low} ↔ ${t.facet.high}; ${t.certainty} certainty)`,
  );
  const patterns = doc.insights.map((i) => `- ${oneLine(i.text)} [${i.evidence.join(', ')}]`);
  const answers = doc.evidence.slice(-PERSONA_MAX_ANSWERS).map((e) => {
    const chosen = e.options[e.optionKeys.indexOf(e.answer)] ?? e.answer;
    const why = e.why ? ` (why: ${oneLine(e.why).slice(0, WHY_CHARS)})` : '';
    return `#${e.seq} ${oneLine(e.prompt)} [${e.options.join(' | ')}] → ${chosen}${why}`;
  });
  return [
    `CONTEXT:\n${ctx.join('\n')}`,
    `TENDENCIES:\n${tendencies.join('\n') || 'none yet'}`,
    `PATTERNS:\n${patterns.join('\n') || 'none yet'}`,
    `ANSWERS:\n${answers.join('\n')}`,
  ].join('\n\n');
}

/**
 * Writes a draft with `persona.v1`. The citation guard matches the reflector's: a statement must cite at least one
 * real answer, or it is dropped.
 */
export async function writePersonaDraft(
  gateway: Gateway,
  ctx: CallContext,
  input: { model: string; doc: MimicJson; facets: Facet[] },
): Promise<{ draft: PersonaDraft; dropped: number; modelSnapshot: string }> {
  const p = PROMPTS['persona.v1'];
  const res = await gateway.chat(ctx, {
    model: input.model,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: personaWriterInput(input.doc, input.facets) },
    ],
    jsonSchema: { name: 'persona', schema: p.schema },
    reasoningEffort: 'medium',
    maxTokens: 16_000,
  });
  const parsed = RawDraft.safeParse(parseJsonLoose(res.content));
  if (!parsed.success) throw new Error('persona writer returned invalid JSON');
  const valid = new Set(input.doc.evidence.map((e) => e.seq));
  const sections = new Set<string>(STATEMENT_SECTIONS);
  const perSection = new Map<string, number>();
  const seen = new Set<string>();
  const statements: PersonaStatement[] = [];
  let dropped = 0;
  for (const s of parsed.data.statements) {
    const text = stripInlineCites(s.text).slice(0, 400);
    const cites = [...new Set(s.evidenceSeqs.filter((x) => valid.has(x)))].sort((a, b) => a - b);
    const n = perSection.get(s.section) ?? 0;
    if (!sections.has(s.section) || text.length < 3 || !cites.length || n >= MAX_PER_SECTION) {
      dropped++;
      continue;
    }
    if (seen.has(`${s.section}|${text}`)) continue;
    seen.add(`${s.section}|${text}`);
    perSection.set(s.section, n + 1);
    statements.push(
      PersonaStatement.parse({ section: s.section, text, evidenceSeqs: cites, confidence: s.confidence }),
    );
  }
  const draft = PersonaDraft.parse({
    summary: stripInlineCites(parsed.data.summary).slice(0, 1200),
    statements,
  });
  return { draft, dropped, modelSnapshot: res.modelSnapshot };
}

// ---------------------------------------------------------------------------------------------------------------
// The view (for curation) and the file
// ---------------------------------------------------------------------------------------------------------------

export interface PersonaItem {
  key: string;
  /** The text before any edit by the person. */
  text: string;
  /** Secondary text: sources, poles and certainty, or the question's options. */
  detail: string | null;
  cites: number[];
  editable: boolean;
  /** Statements resting on little evidence. */
  tentative?: boolean;
  /** Tendencies: the facet group. */
  group?: string;
  /** Decision record: what was asked and chosen. */
  answer?: { options: string[]; chosen: string; why: string | null };
}

export interface PersonaSection {
  id: PersonaSectionId;
  title: string;
  about: string;
  items: PersonaItem[];
}

export interface PersonaDraftMeta {
  id: string;
  createdAt: number;
  seqUpTo: number;
  snapshotVersion: number;
  modelSnapshot: string;
  promptVersion: string;
}

export interface PersonaInput {
  doc: MimicJson;
  facets: Facet[];
  draft: (PersonaDraftMeta & { draft: PersonaDraft }) | null;
  curation: PersonaCuration;
}

export interface PersonaView {
  name: string;
  sections: PersonaSection[];
  markdown: string;
  snapshot: { version: number; seqUpTo: number; answers: number };
  draft: (PersonaDraftMeta & { newAnswers: number }) | null;
  /** Answers needed before a draft can be written. */
  minAnswers: number;
  curation: PersonaCuration;
}

const short = (s: string) => sha256Hex(s).slice(0, 12);
export const personaKey = {
  summary: () => 'summary',
  statement: (s: Pick<PersonaStatement, 'section' | 'text'>) => `st:${short(`${s.section}|${s.text}`)}`,
  identity: (field: 'location' | 'occupation') => `id:${field}`,
  fact: (f: { predicate: string; object: string }) => `fact:${short(`${f.predicate}|${f.object}`)}`,
  trait: (facetId: string) => `trait:${facetId}`,
  insight: (text: string) => `ins:${short(text)}`,
  record: (seq: number) => `ex:${seq}`,
};

type Certainty = 'low' | 'moderate' | 'high';
function certaintyOf(confidence: number): Certainty {
  return confidence >= 0.66 ? 'high' : confidence >= 0.4 ? 'moderate' : 'low';
}

interface TraitLine {
  facet: Facet;
  label: string;
  certainty: Certainty;
}

/** Scored answers needed before the file calls itself a strong prior. */
export const STRONG_MIN_SCORED = 20;

/** Below this certainty, or with no direct evidence, a facet goes under "Not known yet". */
export const KNOWN_MIN_CONFIDENCE = 0.4;

/** One line per facet with an estimate, preferring the decision model's read over psychometric scoring. */
function traitLines(doc: MimicJson, facets: Facet[]): Array<TraitLine & { known: boolean }> {
  const best = new Map<string, MimicJson['traits'][number]>();
  for (const t of doc.traits) {
    const cur = best.get(t.facet);
    if (!cur || (t.method === 'jev' && cur.method !== 'jev')) best.set(t.facet, t);
  }
  const out: Array<TraitLine & { known: boolean }> = [];
  for (const f of facets) {
    const t = best.get(f.id);
    if (!t) continue;
    const idx = Math.max(0, Math.min(4, Math.round(t.mean * 4)));
    out.push({
      facet: f,
      label: f.labels[idx] ?? f.labels[2],
      certainty: certaintyOf(t.confidence),
      known: t.n > 0 && t.confidence >= KNOWN_MIN_CONFIDENCE,
    });
  }
  return out;
}

const PREDICATES: Record<string, string> = {
  worksAt: 'Works at',
  livesIn: 'Lives in',
  hasSkill: 'Skill',
  hasInterest: 'Interest',
  knowsAbout: 'Knows about',
  alumniOf: 'Studied at',
  jobTitle: 'Job title',
  headline: 'Headline',
  memberOf: 'Member of',
  hasOccupation: 'Occupation',
};
function predicateLabel(p: string): string {
  if (PREDICATES[p]) return PREDICATES[p];
  const words = p.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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

/** Builds the curation view and the Markdown from the same items, so the preview is exactly the file. */
export function buildPersona(input: PersonaInput): PersonaView {
  const { doc, facets, draft, curation } = input;
  const name = curation.name?.trim() || doc.subject.displayName;
  const items = new Map<PersonaSectionId, PersonaItem[]>(PERSONA_SECTIONS.map((s) => [s, []]));
  const push = (s: PersonaSectionId, item: PersonaItem) => items.get(s)!.push(item);

  if (draft) {
    if (draft.draft.summary)
      push('summary', {
        key: personaKey.summary(),
        text: draft.draft.summary,
        detail: null,
        cites: [],
        editable: true,
      });
    for (const st of draft.draft.statements) {
      push(st.section, {
        key: personaKey.statement(st),
        text: st.text,
        detail: null,
        cites: st.evidenceSeqs,
        editable: true,
        tentative: st.confidence < 0.5,
      });
    }
  }

  if (doc.subject.occupation)
    push('background', {
      key: personaKey.identity('occupation'),
      text: doc.subject.occupation,
      detail: null,
      cites: [],
      editable: false,
    });
  if (doc.subject.location)
    push('background', {
      key: personaKey.identity('location'),
      text: `Based in ${doc.subject.location}`,
      detail: null,
      cites: [],
      editable: false,
    });
  const factSeen = new Set<string>();
  for (const f of doc.facts) {
    const key = personaKey.fact(f);
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

  const traits = traitLines(doc, facets);
  for (const t of traits.filter((x) => x.known)) {
    push('tendencies', {
      key: personaKey.trait(t.facet.id),
      text: `${capitalize(t.facet.name)}: ${t.label.charAt(0).toLowerCase()}${t.label.slice(1)}`,
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

  for (const i of doc.insights) {
    push('patterns', {
      key: personaKey.insight(i.text),
      text: oneLine(i.text),
      detail: null,
      cites: [...i.evidence].sort((a, b) => a - b),
      editable: false,
    });
  }

  // Repeats re-ask an earlier prompt to measure consistency; the record keeps the first time it was answered.
  for (const e of doc.evidence.filter((x) => x.kind !== 'repeat')) {
    const chosen = e.options[e.optionKeys.indexOf(e.answer)] ?? e.answer;
    push('record', {
      key: personaKey.record(e.seq),
      text: oneLine(e.prompt),
      detail: null,
      cites: [e.seq],
      editable: false,
      answer: { options: e.options, chosen, why: e.why ? oneLine(e.why) : null },
    });
  }

  const sections: PersonaSection[] = PERSONA_SECTIONS.map((id) => ({
    id,
    ...SECTION_META[id],
    items: items.get(id)!,
  }));
  let draftMeta: PersonaView['draft'] = null;
  if (draft) {
    const { draft: _body, ...meta } = draft;
    draftMeta = { ...meta, newAnswers: doc.evidence.filter((e) => e.seq > draft.seqUpTo).length };
  }
  return {
    name,
    sections,
    markdown: renderPersonaMarkdown({ name, doc, sections, curation }),
    snapshot: { version: doc.version, seqUpTo: doc.seqUpTo, answers: doc.evidence.length },
    draft: draftMeta,
    minAnswers: PERSONA_MIN_ANSWERS,
    curation,
  };
}

function renderPersonaMarkdown(args: {
  name: string;
  doc: MimicJson;
  sections: PersonaSection[];
  curation: PersonaCuration;
}): string {
  const { name, doc, sections, curation } = args;
  const off = new Set<string>(curation.disabled);
  const hidden = new Set(curation.hidden);
  const on = (id: PersonaSectionId) => !off.has(id);
  const visible = (id: PersonaSectionId) =>
    on(id) ? sections.find((s) => s.id === id)!.items.filter((i) => !hidden.has(i.key)) : [];
  const textOf = (i: PersonaItem) => oneLine(curation.edits[i.key] ?? i.text);

  // Citations point into the decision record, so they are shown only for answers that made it into the file.
  const recordSeqs = new Set(visible('record').flatMap((i) => i.cites));
  const cite = (seqs: number[]) => {
    const shown = seqs.filter((s) => recordSeqs.has(s));
    return shown.length ? ` [${shown.map((s) => `#${s}`).join(', ')}]` : '';
  };
  const first = firstName(name);
  const date = new Date(doc.createdAt).toISOString().slice(0, 10);
  const out: string[] = [`# Persona: ${name}`, ''];
  out.push(
    `A portrait of how ${name} thinks and makes decisions, built by Mimic from ${doc.evidence.length} answers they gave about themselves. Snapshot v${doc.version}, ${date}.`,
  );

  const section = (id: PersonaSectionId, body: string[]) => {
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
    if (doc.fidelity && doc.fidelity.n > 0) {
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const f = doc.fidelity;
      const base = f.accBaseline === null ? '' : ` (${pct(f.accBaseline)} from context alone)`;
      // Only a model with enough scored answers that beats the context-only baseline earns "strong prior".
      const strong = f.n >= STRONG_MIN_SCORED && (f.accBaseline === null || f.acc > f.accBaseline);
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

/** Drops hidden keys and edits that no longer match any item, so curation doesn't grow without bound. */
export function pruneCuration(c: PersonaCuration, sections: PersonaSection[]): PersonaCuration {
  const keys = new Set(sections.flatMap((s) => s.items.map((i) => i.key)));
  const editable = new Set(sections.flatMap((s) => s.items.filter((i) => i.editable).map((i) => i.key)));
  return {
    ...c,
    hidden: [...new Set(c.hidden.filter((k) => keys.has(k)))],
    edits: Object.fromEntries(Object.entries(c.edits).filter(([k]) => editable.has(k))),
  };
}
