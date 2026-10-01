import { z } from 'zod';
import { normalizeDist } from '../distribution';
import {
  type FootprintDoc,
  footprintTokens,
  ownWordsOnly,
  scrubIdentifiers,
  selectDocs,
  sensitiveAreasOf,
} from '../footprint';
import { GATES_VERSION } from '../jev';
import { type DraftQuestion, runQualityGates, validateDraft } from '../learning';
import { parseJsonLoose } from '../predictors';
import { PROMPTS } from '../prompts';
import { questionAllowed } from '../scope';
import { lexicalSimilarity } from '../state-builder';
import type { PredictionRecord, QuestionRecord } from '../store';
import type { Distribution, Facet } from '../types';
import { loadMimicData, vectorId } from './data';
import {
  budgetSpent,
  ctxFor,
  type EngineDeps,
  EngineError,
  facetsFor,
  jevModel,
  loadConfig,
  requireMimic,
} from './deps';
import { MAX_POOL } from './session';

/**
 * Footprint proposals (ADR-0061): verify, never infer. The person's own documents are read once by an LLM that
 * writes questions whose answers the documents imply. Each becomes an ordinary pooled question, and the implied
 * answer is stored beside it (`quality.footprint`). When the session serves one, the implied answer is written as a
 * prediction of its own (`predictorId = footprint:v1`, role `shadow`, no state), so the person's real answer scores
 * the footprint exactly as it scores every model, per source. Nothing from a document enters a state, a trait or
 * an insight until the person has answered.
 */

export const FOOTPRINT_PREDICTOR_ID = 'footprint:v1';
export const FOOTPRINT_PROMPT_VERSION = 'footprint.v1';
export const FOOTPRINT_DOC_BUDGET = 6000;
export const FOOTPRINT_MAX_ITEMS = 12;

export const FootprintMeta = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  docIds: z.array(z.string()),
  sources: z.array(z.string()),
});
export type FootprintMeta = z.infer<typeof FootprintMeta>;

const RawItem = z.object({
  type: z.enum(['choice', 'noul', 'score']),
  prompt: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string() })),
  facetIds: z.array(z.string()).catch([]),
  answer: z.string(),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  docIds: z.array(z.string()).catch([]),
});
const RawItems = z.object({ items: z.array(z.unknown()).catch([]) });

export interface ProposeResult {
  /** Documents read, after the budget. */
  docs: number;
  tokens: number;
  proposed: number;
  pooled: number;
  /** Why the rest were dropped, by reason. */
  dropped: Record<string, number>;
  learns: boolean;
}

/** The facets a footprint may propose on: in the person's scope and never sensitive. */
export function footprintFacets(facets: Facet[]): Facet[] {
  return facets.filter((f) => !f.sensitive);
}

/** The prompt's variable part: facets first (stable per person), documents after, most recent first. */
export function footprintInput(facets: Facet[], docs: FootprintDoc[], n: number): string {
  const facetLines = facets.map((f) => `${f.id}: ${f.name}, ${f.low} ↔ ${f.high}`);
  const docLines = docs.map((d) => {
    const date = d.at === null ? 'undated' : new Date(d.at).toISOString().slice(0, 10);
    return `[${d.id}] ${date} · ${d.source} ${d.kind} · ${d.text.replace(/\s+/g, ' ')}`;
  });
  return `FACETS:\n${facetLines.join('\n')}\n\nDOCUMENTS:\n${docLines.join('\n')}\n\nWrite up to ${n} items.`;
}

/** The implied answer as a distribution: `confidence` on it, the rest spread evenly over the other options. */
export function footprintDistribution(q: Pick<QuestionRecord, 'options'>, meta: FootprintMeta): Distribution {
  const keys = q.options.map((o) => o.key);
  const rest = keys.length > 1 ? (1 - meta.confidence) / (keys.length - 1) : 0;
  return normalizeDist(
    Object.fromEntries(keys.map((k) => [k, k === meta.answer ? meta.confidence : rest])),
    keys,
  );
}

/** The stored footprint meta of a pooled question, or null. */
export function footprintMetaOf(q: Pick<QuestionRecord, 'quality' | 'provenance'>): FootprintMeta | null {
  if (q.provenance.promptVersion !== FOOTPRINT_PROMPT_VERSION) return null;
  const r = FootprintMeta.safeParse((q.quality as { footprint?: unknown } | null)?.footprint);
  return r.success ? r.data : null;
}

/** The footprint's own prediction row for a served question, sealed trivially (it reads no answers). */
export function footprintPrediction(
  deps: Pick<EngineDeps, 'newId' | 'clock'>,
  m: { id: string; configHash: string },
  q: QuestionRecord,
): PredictionRecord | null {
  const meta = footprintMetaOf(q);
  if (!meta) return null;
  return {
    id: deps.newId(),
    questionId: q.id,
    mimicId: m.id,
    predictorId: FOOTPRINT_PREDICTOR_ID,
    role: 'shadow',
    dist: footprintDistribution(q, meta),
    confidence: meta.confidence,
    stateHash: 'footprint',
    evidenceSeqMax: 0,
    configHash: m.configHash,
    promptVersion: FOOTPRINT_PROMPT_VERSION,
    modelSnapshot: `${FOOTPRINT_PROMPT_VERSION}:${meta.sources.join('+') || 'text'}`,
    costUsd: 0,
    latencyMs: 0,
    ok: true,
    error: null,
    fallback: false,
    createdAt: deps.clock(),
  };
}

/**
 * Reads the documents once and pools the questions they imply answers to. One LLM call through the gateway (logged,
 * budget-guarded) and one Jev gate call per draft; the pool cap applies as it does to generated questions.
 */
export async function proposeFromFootprint(
  deps: EngineDeps,
  mimicId: string,
  input: { docs: FootprintDoc[]; max?: number },
): Promise<ProposeResult> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (budgetSpent(deps, m, cfg)) throw new EngineError('budget', 'Budget reached');
  const loaded = await loadMimicData(deps, m);
  const facets = footprintFacets(await facetsFor(deps, m, cfg));
  // The browser cleaned the documents, but the server holds the same hygiene rules at its own boundary.
  const docs = selectDocs(
    input.docs
      .map((d) => ({ ...d, text: scrubIdentifiers(ownWordsOnly(d.text)) }))
      .filter((d) => d.text.length > 0 && !sensitiveAreasOf(d.text).length),
    FOOTPRINT_DOC_BUDGET,
  );
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  if (!docs.length) return { docs: 0, tokens: 0, proposed: 0, pooled: 0, dropped, learns: true };
  const n = Math.min(input.max ?? FOOTPRINT_MAX_ITEMS, FOOTPRINT_MAX_ITEMS);
  const p = PROMPTS['footprint.v1'];
  const res = await deps.gateway.chat(ctxFor(m, 'footprint.propose'), {
    model: cfg.generator.model,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: footprintInput(facets, docs, n) },
    ],
    jsonSchema: { name: 'footprint', schema: p.schema },
    reasoningEffort: cfg.generator.reasoningEffort,
    maxTokens: 6000,
  });
  const parsed = RawItems.safeParse(parseJsonLoose(res.content));
  const items = parsed.success ? parsed.data.items : [];
  const docIds = new Set(docs.map((d) => d.id));
  const sourceOf = new Map(docs.map((d) => [d.id, d.source]));
  const facetIds = new Set(facets.map((f) => f.id));
  const existing = loaded.questions.filter((q) => q.kind !== 'repeat' && q.status !== 'discarded');
  const pool = loaded.questions.filter((q) => q.kind === 'adaptive' && q.status === 'pooled');
  const room = Math.max(0, MAX_POOL - pool.length);

  const drafts: Array<{ d: DraftQuestion; meta: FootprintMeta }> = [];
  for (const raw of items.slice(0, n)) {
    const r = RawItem.safeParse(raw);
    if (!r.success) {
      drop('schema');
      continue;
    }
    const it = r.data;
    const cited = [...new Set(it.docIds.filter((id) => docIds.has(id)))];
    if (!cited.length) {
      drop('no citation');
      continue;
    }
    if (it.facetIds.some((f) => !facetIds.has(f))) {
      drop('facet not allowed');
      continue;
    }
    const v = validateDraft({ ...it, domain: 'casual' }, facetIds, loaded.scope.blocked);
    if ('error' in v) {
      drop(v.error);
      continue;
    }
    if (!questionAllowed(v, loaded.scope.blocked)) {
      drop('out of scope');
      continue;
    }
    if (sensitiveAreasOf([v.prompt, ...v.options.map((o) => o.label)].join(' ')).length) {
      drop('sensitive wording');
      continue;
    }
    // The answer travels by position through the gate's re-keying, like a taught answer (ADR-0032).
    const i = it.options.findIndex((o) => o.key === it.answer);
    const answer =
      v.type === 'noul' && (it.answer === 'yes' || it.answer === 'no') ? it.answer : v.options[i]?.key;
    if (!answer) {
      drop('answer not an option');
      continue;
    }
    if (
      existing.some((q) => lexicalSimilarity(q.prompt, v.prompt) > 0.8) ||
      drafts.some((x) => lexicalSimilarity(x.d.prompt, v.prompt) > 0.8)
    ) {
      drop('duplicate');
      continue;
    }
    drafts.push({
      d: v,
      meta: {
        answer,
        confidence: Math.max(0.5, it.confidence),
        docIds: cited,
        sources: [...new Set(cited.map((id) => sourceOf.get(id)!))].sort(),
      },
    });
  }

  const gatesVersion = cfg.generator.gates ?? GATES_VERSION;
  const gates = drafts.length
    ? await runQualityGates(
        deps.gateway,
        ctxFor(m, 'footprint.gate'),
        jevModel(deps),
        drafts.map((x) => x.d),
        {
          version: gatesVersion,
          facets,
        },
      )
    : [];
  const now = deps.clock();
  const recs: QuestionRecord[] = [];
  drafts.forEach(({ d, meta }, i) => {
    const g = gates[i]!;
    if (!g.passed) {
      drop(`gate: ${g.failures.join(', ')}`);
      return;
    }
    if (recs.length >= room) {
      drop('pool full');
      return;
    }
    recs.push({
      id: deps.newId(),
      mimicId: m.id,
      seq: null,
      kind: 'adaptive',
      type: d.type,
      domain: d.domain,
      prompt: d.prompt,
      options: d.options,
      facetIds: d.facetIds,
      provenance: {
        generator: 'footprint',
        configHash: m.configHash,
        promptVersion: FOOTPRINT_PROMPT_VERSION,
      },
      status: 'pooled',
      quality: { gates: g.p, gatesVersion, footprint: meta },
      createdAt: now + recs.length,
      servedAt: null,
      stateAt: null,
    });
  });
  if (recs.length) {
    await deps.store.insertQuestions(recs);
    // Embedded like generated questions, so refills dedupe against them and selection measures their redundancy.
    try {
      const { vectors } = await deps.gateway.embed(
        ctxFor(m, 'footprint.embed'),
        recs.map((r) => r.prompt),
      );
      await deps.vectors.upsert(
        recs.map((r, i) => ({
          id: vectorId.question(m.id, r.id),
          values: vectors[i]!,
          metadata: { mimicId: m.id, kind: 'question' as const, facetIds: r.facetIds.join(','), seq: 0 },
        })),
      );
    } catch {
      // Without vectors, dedupe and redundancy fall back to lexical similarity, as for any unembedded question.
    }
  }
  return {
    docs: docs.length,
    tokens: footprintTokens(docs),
    proposed: items.length,
    pooled: recs.length,
    dropped,
    learns: !budgetSpent(deps, m, cfg),
  };
}
