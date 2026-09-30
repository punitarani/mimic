import { z } from 'zod';
import type { PipelineConfig } from '../config';
import { hashJson, seededRng, sha256Hex, shuffle } from '../hash';
import { samePersonQuestion } from '../jev';
import { getAnchorSet } from '../ontology';
import type {
  CandidateRecord,
  FactRecord,
  KgEdgeRecord,
  KgNodeRecord,
  KgNodeType,
  MimicRecord,
  QuestionRecord,
} from '../store';
import type { PersonCandidate } from '../types';
import { vectorId } from './data';
import {
  allocateArm,
  ctxFor,
  type EngineDeps,
  EngineError,
  ensureDefaultConfig,
  jevModel,
  loadConfig,
  requireMimic,
  splitFor,
} from './deps';

export const IntakeInput = z.object({
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().min(2).max(120),
  occupation: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  employer: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  link: z
    .string()
    .trim()
    .url()
    .max(300)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  attestSelf: z.literal(true),
  consentSearch: z.boolean(),
  consentResearch: z.boolean(),
});
export type IntakeInput = z.infer<typeof IntakeInput>;

/** Creates a mimic, assigns its config (experiment arm or default), seeds anchors and kicks off identity. */
export async function createMimic(
  deps: EngineDeps,
  input: IntakeInput,
  participantId: string,
): Promise<MimicRecord> {
  const now = deps.clock();
  const id = deps.newId();
  await deps.store.ensureParticipant(participantId, now);

  let cfgHash = await ensureDefaultConfig(deps);
  let experimentId: string | null = null;
  let arm: string | null = null;
  const active = (await deps.store.listExperiments()).find((e) => e.status === 'active' && e.arms.length > 0);
  if (active) {
    const chosen = allocateArm(id, active.id, active.arms);
    cfgHash = chosen.configHash;
    experimentId = active.id;
    arm = chosen.arm;
  }
  const cfg = await loadConfig(deps, cfgHash);

  const m: MimicRecord = {
    id,
    participantId,
    displayName: input.name,
    location: input.location,
    occupation: input.occupation ?? null,
    employer: input.employer ?? null,
    links: input.link ? [input.link] : [],
    status: input.consentSearch ? 'identity' : 'learning',
    identityState: input.consentSearch ? 'searching' : 'skipped',
    configHash: cfgHash,
    experimentId,
    arm,
    consentApp: true,
    consentSearch: input.consentSearch,
    consentResearch: input.consentResearch,
    split: splitFor(id),
    seqMax: 0,
    snapshotVersion: 0,
    spendUsd: 0,
    createdAt: now,
    updatedAt: now,
  };
  await deps.store.insertMimic(m);
  await deps.store.insertQuestions(anchorQuestions(deps, m, cfg, now));
  await deps.store.insertKg([personNode(m, now)], []);
  if (input.consentSearch) await deps.jobs.enqueue({ type: 'identity.search', mimicId: id });
  await deps.jobs.enqueue({ type: 'pool.refill', mimicId: id, seq: 0 });
  return m;
}

/** Anchors are inserted up front in a per-person random order, encoded in createdAt (PLAN §9.3). */
function anchorQuestions(
  deps: EngineDeps,
  m: MimicRecord,
  cfg: PipelineConfig,
  now: number,
): QuestionRecord[] {
  const items = shuffle(getAnchorSet(cfg.anchors.setId), seededRng(`anchors:${m.id}`)).slice(
    0,
    cfg.anchors.count,
  );
  return items.map((item, i) => ({
    id: deps.newId(),
    mimicId: m.id,
    seq: null,
    kind: 'anchor',
    type: item.type,
    domain: item.domain,
    prompt: item.prompt,
    options: item.options,
    facetIds: item.facetIds,
    itemKey: item.itemKey,
    provenance: { generator: cfg.anchors.setId, configHash: m.configHash, promptVersion: cfg.anchors.setId },
    status: 'pooled',
    quality: null,
    createdAt: now + i,
    servedAt: null,
  }));
}

export function personNodeId(mimicId: string): string {
  return `${mimicId}:person`;
}

function personNode(m: MimicRecord, now: number): KgNodeRecord {
  return {
    id: personNodeId(m.id),
    mimicId: m.id,
    type: 'Person',
    label: 'You',
    props: {},
    source: 'intake',
    createdAt: now,
  };
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function searchCacheKey(m: Pick<MimicRecord, 'displayName' | 'location' | 'occupation'>): string {
  return `search:${sha256Hex([m.displayName, m.location, m.occupation].map(normalize).join('|'))}`;
}

export function searchQueries(
  m: Pick<MimicRecord, 'displayName' | 'location' | 'occupation' | 'employer'>,
): string[] {
  const occ = m.occupation ? ` ${m.occupation}` : '';
  const qs = [`"${m.displayName}"${occ} ${m.location}`];
  if (m.employer) qs.push(`"${m.displayName}"${occ} ${m.employer} ${m.location}`);
  qs.push(`"${m.displayName}" ${m.location}`);
  return [...new Set(qs.map((q) => q.replace(/\s+/g, ' ').trim()))].slice(0, 3);
}

const CachedCandidates = z.array(
  z.object({
    provider: z.string(),
    name: z.string(),
    headline: z.string().optional(),
    location: z.string().optional(),
    url: z.string(),
    summary: z.string(),
  }),
);

const SEARCH_TTL_SECONDS = 7 * 24 * 3600;
export const MAX_CANDIDATES = 8;

/** `identity.search` (PLAN §9.2 steps 1–2). Never runs unless the person consented to search. */
export async function runIdentitySearch(deps: EngineDeps, mimicId: string, jobKey?: string): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  if (!m.consentSearch) return; // declining search makes zero search calls
  if ((await deps.store.listCandidates(m.id)).length > 0) return;
  const now = deps.clock();

  let candidates: PersonCandidate[];
  const cacheKey = searchCacheKey(m);
  const cached = await deps.kv.get(cacheKey);
  const parsedCache = cached ? CachedCandidates.safeParse(JSON.parse(cached)) : null;
  if (parsedCache?.success) {
    candidates = parsedCache.data as PersonCandidate[];
  } else {
    const results = await Promise.all(
      searchQueries(m).map((q) =>
        deps.gateway.searchPeople(ctxFor(m, 'identity.search', jobKey), q, MAX_CANDIDATES).catch(() => null),
      ),
    );
    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
    await deps.blobs.put(
      `search/${m.id}/${ok[0]?.candidates[0]?.provider ?? 'exa'}/${now}.json`,
      JSON.stringify(ok.map((r) => r.raw)),
      'application/json',
    );
    const seen = new Set<string>();
    candidates = [];
    for (const r of ok) {
      for (const c of r.candidates) {
        const key = c.url.replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(c);
      }
    }
    candidates = candidates.slice(0, MAX_CANDIDATES);
    if (ok.length)
      await deps.kv.put(cacheKey, JSON.stringify(candidates), { ttlSeconds: SEARCH_TTL_SECONDS });
  }

  // Pre-rank: one Jev request per candidate, all in parallel.
  const intake = {
    name: m.displayName,
    location: m.location,
    occupation: m.occupation ?? undefined,
    employer: m.employer ?? undefined,
    link: m.links[0],
  };
  const scored = await Promise.all(
    candidates.map(async (c) => {
      try {
        const res = await deps.gateway.decide(ctxFor(m, 'identity.rank', jobKey), {
          model: jevModel(deps),
          state: {
            intake,
            candidate: {
              name: c.name,
              headline: c.headline,
              location: c.location,
              url: c.url,
              summary: c.summary,
            },
          },
          questions: { same_person: samePersonQuestion() },
        });
        const a = res.answers.same_person;
        return { c, p: a?.type === 'noul' ? a.p : null };
      } catch {
        return { c, p: null };
      }
    }),
  );
  scored.sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
  const recs: CandidateRecord[] = scored.map(({ c, p }, i) => ({
    id: deps.newId(),
    mimicId: m.id,
    provider: c.provider,
    rank: i + 1,
    name: c.name,
    headline: c.headline ?? null,
    location: c.location ?? null,
    url: c.url,
    summary: c.summary.slice(0, 2000),
    jevSamePersonP: p,
    r2Key: null,
    status: 'proposed',
    createdAt: now,
  }));
  await deps.store.insertCandidates(recs);
  await deps.store.updateMimic(m.id, {
    identityState: recs.length ? 'candidates' : 'none_found',
    updatedAt: deps.clock(),
  });
}

/** The person picks a candidate or "None of these". Never auto-confirmed (PLAN §9.2 step 3). */
export async function confirmIdentity(
  deps: EngineDeps,
  mimicId: string,
  candidateId: string | null,
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  const candidates = await deps.store.listCandidates(m.id);
  if (candidateId && !candidates.some((c) => c.id === candidateId)) {
    throw new EngineError('not_found', 'Candidate not found');
  }
  for (const c of candidates) {
    await deps.store.updateCandidate(c.id, { status: c.id === candidateId ? 'confirmed' : 'rejected' });
  }
  if (!candidateId) {
    await finishIdentity(deps, m.id);
    return;
  }
  const chosen = candidates.find((c) => c.id === candidateId)!;
  const now = deps.clock();
  const facts: FactRecord[] = [];
  if (chosen.headline) facts.push(fact(deps, m.id, 'headline', chosen.headline, chosen.url, 0.8, now));
  if (chosen.location) facts.push(fact(deps, m.id, 'livesIn', chosen.location, chosen.url, 0.7, now));
  await addFacts(deps, m, facts);
  await deps.store.updateMimic(m.id, { identityState: 'enriching', updatedAt: now });
  await deps.jobs.enqueue({ type: 'identity.enrich', mimicId: m.id, candidateId });
}

function fact(
  deps: EngineDeps,
  mimicId: string,
  predicate: string,
  object: string,
  url: string | null,
  confidence: number,
  now: number,
  source: FactRecord['source'] = 'search',
  sourceRef: string | null = null,
): FactRecord {
  return {
    id: deps.newId(),
    mimicId,
    predicate,
    object: object.slice(0, 300),
    source,
    sourceRef,
    sourceUrl: url,
    confidence,
    userState: 'active',
    createdAt: now,
  };
}

/** `identity.enrich` (PLAN §9.2 step 4): structured facts with sources. */
export async function runIdentityEnrich(
  deps: EngineDeps,
  mimicId: string,
  candidateId: string,
  jobKey?: string,
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  if (!m.consentSearch || m.identityState !== 'enriching') return;
  const c = (await deps.store.listCandidates(m.id)).find((x) => x.id === candidateId);
  if (c?.status !== 'confirmed') return;
  const now = deps.clock();
  try {
    const subject: { name: string; location: string; url: string; occupation?: string; employer?: string } = {
      name: m.displayName,
      location: m.location,
      url: c.url,
    };
    if (m.occupation) subject.occupation = m.occupation;
    if (m.employer) subject.employer = m.employer;
    const res = await deps.gateway.enrich(ctxFor(m, 'identity.enrich', jobKey), subject);
    await deps.blobs.put(`search/${m.id}/enrich/${now}.json`, JSON.stringify(res.raw), 'application/json');
    const existing = new Set(
      (await deps.store.listFacts(m.id)).map((f) => `${f.predicate}|${normalize(f.object)}`),
    );
    const facts = res.facts
      .filter((f) => !existing.has(`${f.predicate}|${normalize(f.object)}`))
      .map((f) => fact(deps, m.id, f.predicate, f.object, f.sourceUrl ?? c.url, f.confidence, now));
    await addFacts(deps, m, facts);
  } catch {
    // Enrichment is best-effort: the person still reviews whatever facts exist.
  }
  await deps.store.updateMimic(m.id, { identityState: 'review', updatedAt: deps.clock() });
}

/** Ends identity resolution; the session can start. */
export async function finishIdentity(deps: EngineDeps, mimicId: string): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  if (m.identityState === 'searching' || m.identityState === 'enriching') {
    // "Skip" is always available: pending jobs will see the new state and stop.
  }
  await deps.store.updateMimic(m.id, {
    identityState: m.identityState === 'skipped' ? 'skipped' : 'done',
    status: m.status === 'identity' || m.status === 'intake' ? 'learning' : m.status,
    updatedAt: deps.clock(),
  });
}

export async function setFactState(
  deps: EngineDeps,
  mimicId: string,
  factId: string,
  userState: 'active' | 'removed',
): Promise<void> {
  const ok = await deps.store.updateFact(mimicId, factId, { userState });
  if (!ok) throw new EngineError('not_found', 'Fact not found');
  if (userState === 'removed')
    await deps.vectors.deleteByIds([vectorId.fact(mimicId, factId)]).catch(() => {});
}

const PREDICATE_NODE: Record<string, { type: KgNodeType; edge: string }> = {
  worksAt: { type: 'Organization', edge: 'worksFor' },
  worked_at: { type: 'Organization', edge: 'workedFor' },
  workedAt: { type: 'Organization', edge: 'workedFor' },
  alumniOf: { type: 'Organization', edge: 'alumniOf' },
  educatedAt: { type: 'Organization', edge: 'alumniOf' },
  livesIn: { type: 'Place', edge: 'homeLocation' },
  hasSkill: { type: 'Skill', edge: 'knowsAbout' },
  knowsAbout: { type: 'Skill', edge: 'knowsAbout' },
  hasInterest: { type: 'Interest', edge: 'interestedIn' },
  jobTitle: { type: 'Occupation', edge: 'hasOccupation' },
  headline: { type: 'Occupation', edge: 'hasOccupation' },
};

/** Inserts facts and mirrors them into the KG (with provenance) and the vector index. */
export async function addFacts(deps: EngineDeps, m: MimicRecord, facts: FactRecord[]): Promise<void> {
  if (!facts.length) return;
  await deps.store.insertFacts(facts);
  const kg = await deps.store.listKg(m.id);
  const nodeByKey = new Map(kg.nodes.map((n) => [`${n.type}|${normalize(n.label)}`, n]));
  const nodes: KgNodeRecord[] = [];
  const edges: KgEdgeRecord[] = [];
  for (const f of facts) {
    const map = PREDICATE_NODE[f.predicate];
    if (!map) continue;
    const key = `${map.type}|${normalize(f.object)}`;
    let node = nodeByKey.get(key);
    if (!node) {
      node = {
        id: `${m.id}:n:${hashJson(key).slice(0, 16)}`,
        mimicId: m.id,
        type: map.type,
        label: f.object.slice(0, 80),
        props: f.sourceUrl ? { url: f.sourceUrl } : {},
        source: f.source,
        createdAt: f.createdAt,
      };
      nodeByKey.set(key, node);
      nodes.push(node);
    }
    edges.push({
      id: deps.newId(),
      mimicId: m.id,
      src: personNodeId(m.id),
      dst: node.id,
      predicate: map.edge,
      weight: f.confidence,
      source: f.source,
      sourceRef: f.id,
      createdAt: f.createdAt,
    });
  }
  await deps.store.insertKg(nodes, edges);
  try {
    const texts = facts.map((f) => `${f.predicate}: ${f.object}`);
    const emb = await deps.gateway.embed(ctxFor(m, 'embed.fact'), texts);
    await deps.vectors.upsert(
      facts.map((f, i) => ({
        id: vectorId.fact(m.id, f.id),
        values: emb.vectors[i]!,
        metadata: { mimicId: m.id, kind: 'fact' as const, facetIds: '', seq: 0 },
      })),
    );
  } catch {
    // Embeddings are an index, not a source of truth; they can be rebuilt from facts.
  }
}
