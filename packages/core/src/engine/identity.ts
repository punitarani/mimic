import { z } from 'zod';
import type { PipelineConfig } from '../config';
import { hashJson, seededRng, sha256Hex, shuffle } from '../hash';
import { samePersonQuestion } from '../jev';
import { isWebLink, profileKey } from '../links';
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

/** A profile link: http(s) only, since it is rendered as a link and sent to search. */
export const HttpUrl = z
  .string()
  .trim()
  .max(300)
  .refine(isWebLink, 'Use a web link, like https://linkedin.com/in/you');

/** An optional intake field: blank (after trimming) is absent, so it can't hide another field downstream. */
const OptionalText = z
  .string()
  .trim()
  .max(120)
  .transform((v) => v || undefined)
  .optional();

export const IntakeInput = z.object({
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().min(2).max(120),
  occupation: OptionalText,
  employer: OptionalText,
  link: HttpUrl.optional().or(z.literal('').transform(() => undefined)),
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
    evidenceEpoch: 0,
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
    stateAt: null,
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

type SearchSubject = Pick<MimicRecord, 'displayName' | 'location' | 'occupation' | 'employer' | 'links'>;

/** Search results are cached per intake, including the link searched with (the person's newest link). */
export function searchCacheKey(m: SearchSubject, link: string | null = m.links[0] ?? null): string {
  const parts = [m.displayName, m.location, m.occupation, m.employer, link ? profileKey(link) : ''];
  return `search:v2:${sha256Hex(parts.map(normalize).join('|'))}`;
}

/** Every search-cache key a mimic may have written: one per link it searched with, plus the pre-v2 key. */
export function searchCacheKeys(m: SearchSubject): string[] {
  const v1 = `search:${sha256Hex([m.displayName, m.location, m.occupation].map(normalize).join('|'))}`;
  return [...new Set([v1, searchCacheKey(m, null), ...m.links.map((l) => searchCacheKey(m, l))])];
}

/**
 * Query variants for Exa people search (PLAN §9.2 step 1, ADR-0029). The index is semantic: a quoted name is not
 * a phrase match, and in live checks it returned strangers or nothing at all. So each query is a plain description
 * that leads with the name, from most to least specific.
 */
export function searchQueries(
  m: Pick<MimicRecord, 'displayName' | 'location' | 'occupation' | 'employer'>,
): string[] {
  // `||`, not `??`: a blank occupation must not hide the employer or school.
  const occupation = m.occupation?.trim();
  const employer = m.employer?.trim();
  const role = occupation && employer ? `${occupation} at ${employer}` : occupation || employer || '';
  const qs = role
    ? [`${m.displayName}, ${role}, ${m.location}`, `${m.displayName}, ${role}`, m.displayName]
    : [`${m.displayName}, ${m.location}`, m.displayName];
  return [...new Set(qs.map((q) => q.replace(/\s+/g, ' ').trim()))];
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'cpa', 'esq']);

/**
 * Lowercase name parts without accents, apostrophes (O'Brien = OBrien), other punctuation or suffixes (Jr., PhD):
 * "Alondra M." → ["alondra", "m"].
 */
function nameTokens(s: string): string[] {
  const tokens = s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const named = tokens.filter((t) => !NAME_SUFFIXES.has(t));
  return named.length ? named : tokens;
}

/**
 * How well a profile's name matches the intake name: 2 when the first and last names match, 1 when any part
 * matches, 0 otherwise. A last initial that ends the name counts, since LinkedIn shows "Alondra M." to people
 * outside someone's network; a middle initial ("Rosa I. Guerrero") doesn't.
 */
export function nameMatch(intakeName: string, profileName: string): 0 | 1 | 2 {
  const want = nameTokens(intakeName);
  const gotList = nameTokens(profileName);
  const got = new Set(gotList);
  const first = want[0];
  const last = want[want.length - 1];
  if (!first || !last || !got.size) return 0;
  const lastOk = got.has(last) || (want.length > 1 && gotList[gotList.length - 1] === last[0]);
  if (got.has(first) && lastOk) return 2;
  return want.some((t) => got.has(t)) ? 1 : 0;
}

/** Reciprocal-rank constant: small, since each list holds at most 10 results. */
const RRF_K = 10;

/**
 * Merges result lists (the link lookup first, then each query) into one candidate list. A profile several queries
 * rank highly scores higher (reciprocal rank fusion). Profiles with no name in common with the intake are dropped,
 * except the one at the person's own link. Full-name matches come first, then partial ones.
 */
export function mergeCandidates(
  name: string,
  lists: PersonCandidate[][],
  link?: string,
  max = MAX_CANDIDATES,
): PersonCandidate[] {
  const byKey = new Map<string, { c: PersonCandidate; score: number }>();
  for (const list of lists) {
    list.forEach((c, i) => {
      const key = profileKey(c.url);
      const score = 1 / (RRF_K + i + 1);
      const seen = byKey.get(key);
      if (seen) seen.score += score;
      else byKey.set(key, { c, score });
    });
  }
  const own = link ? profileKey(link) : null;
  return [...byKey.entries()]
    .map(([key, v]) => ({ ...v, own: key === own, match: nameMatch(name, v.c.name) }))
    .filter((v) => v.own || v.match > 0)
    .sort((a, b) => Number(b.own) - Number(a.own) || b.match - a.match || b.score - a.score)
    .slice(0, max)
    .map((v) => v.c);
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

function parseCached(raw: string | null): PersonCandidate[] | null {
  if (!raw) return null;
  try {
    const r = CachedCandidates.safeParse(JSON.parse(raw));
    return r.success ? (r.data as PersonCandidate[]) : null;
  } catch {
    return null;
  }
}

const SEARCH_TTL_SECONDS = 7 * 24 * 3600;
/** Results per query: Exa charges the same for 1–10. */
export const RESULTS_PER_QUERY = 10;
/** Candidates pre-ranked by Jev (one cheap request each); the UI shows the best few. */
export const MAX_CANDIDATES = 10;

/** `identity.search` (PLAN §9.2 steps 1–2). Never runs unless the person consented to search. */
export async function runIdentitySearch(deps: EngineDeps, mimicId: string, jobKey?: string): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  if (!m.consentSearch) return; // declining search makes zero search calls
  if (m.identityState !== 'searching') return; // skipped (or already done) before the job ran
  // A redelivered job whose candidates already landed (an earlier search's are superseded): finish what that run
  // started rather than leave the person waiting on a search that is over.
  if ((await deps.store.listCandidates(m.id)).some((c) => c.status === 'proposed')) {
    await deps.store.transitionIdentity(m.id, ['searching'], {
      identityState: 'candidates',
      updatedAt: deps.clock(),
    });
    return;
  }
  const now = deps.clock();
  const link = m.links[0];

  const cacheKey = searchCacheKey(m);
  let candidates = parseCached(await deps.kv.get(cacheKey));
  if (!candidates) {
    const calls = [
      ...(link && deps.gateway.canLookupPeople
        ? [deps.gateway.lookupPerson(ctxFor(m, 'identity.lookup', jobKey), link)]
        : []),
      ...searchQueries(m).map((q) =>
        deps.gateway.searchPeople(ctxFor(m, 'identity.search', jobKey), q, RESULTS_PER_QUERY),
      ),
    ];
    const results = await Promise.all(calls.map((p) => p.catch(() => null)));
    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
    await deps.blobs.put(
      `search/${m.id}/${ok[0]?.candidates[0]?.provider ?? 'exa'}/${now}.json`,
      JSON.stringify(ok.map((r) => r.raw)),
      'application/json',
    );
    candidates = mergeCandidates(
      m.displayName,
      ok.map((r) => r.candidates),
      link,
    );
    // Only a complete, non-empty answer is cached: a transient failure must not stick for a week.
    if (candidates.length && ok.length === results.length)
      await deps.kv.put(cacheKey, JSON.stringify(candidates), { ttlSeconds: SEARCH_TTL_SECONDS });
  }

  // Pre-rank: one Jev request per candidate, all in parallel.
  const intake = {
    name: m.displayName,
    location: m.location,
    occupation: m.occupation ?? undefined,
    employer: m.employer ?? undefined,
    link,
  };
  const scored = await Promise.all(
    candidates.map(async (c) => {
      const own = !!link && profileKey(c.url) === profileKey(link);
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
        return { c, own, p: a?.type === 'noul' ? a.p : null };
      } catch {
        return { c, own, p: null };
      }
    }),
  );
  // The profile at the person's own link leads; the rest follow Jev.
  scored.sort((a, b) => Number(b.own) - Number(a.own) || (b.p ?? -1) - (a.p ?? -1));
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
  // Only from 'searching': the person may have skipped while we searched.
  await deps.store.transitionIdentity(m.id, ['searching'], {
    identityState: recs.length ? 'candidates' : 'none_found',
    updatedAt: deps.clock(),
  });
}

/** Distinct links a person can search with; each costs a few search calls. */
export const MAX_LINKS = 4;

const PENDING_CHOICE = ['candidates', 'none_found'] as const;
const NOT_WAITING = 'Search is not waiting for a choice';

/**
 * "Search with a link": the person didn't see themselves and gave a profile link. The open candidates are set
 * aside as superseded (they weren't judged, so they aren't "not me") and a new search runs with the link as its
 * first lead. Only while a choice is pending.
 */
export async function searchIdentityAgain(deps: EngineDeps, mimicId: string, link: string): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  if (!m.consentSearch) throw new EngineError('forbidden', 'Web search is off for this mimic');
  const key = profileKey(link);
  const others = m.links.filter((l) => profileKey(l) !== key);
  if (others.length >= MAX_LINKS) throw new EngineError('conflict', 'That is as many links as we can search');
  const now = deps.clock();
  // One statement claims the search, so two requests at once can't start two. State goes first, so a poll in
  // between shows the search rather than an empty list.
  const claimed = await deps.store.transitionIdentity(m.id, PENDING_CHOICE, {
    links: [link, ...others],
    identityState: 'searching',
    updatedAt: now,
  });
  if (!claimed) throw new EngineError('conflict', NOT_WAITING);
  const open = (await deps.store.listCandidates(m.id))
    .filter((c) => c.status === 'proposed')
    .map((c) => c.id);
  await deps.store.setCandidateStatus(m.id, open, 'superseded');
  try {
    await deps.jobs.enqueue({ type: 'identity.search', mimicId: m.id, attempt: now });
  } catch (e) {
    // Without a job nothing would ever leave 'searching' (no ledger row for the cron to requeue): put the choice
    // back as it was, so the person can pick or try again.
    await deps.store.setCandidateStatus(m.id, open, 'proposed');
    await deps.store.transitionIdentity(m.id, ['searching'], {
      links: m.links,
      identityState: open.length ? 'candidates' : 'none_found',
      updatedAt: deps.clock(),
    });
    throw e;
  }
}

/** The person picks a candidate or "None of these". Never auto-confirmed (PLAN §9.2 step 3). */
export async function confirmIdentity(
  deps: EngineDeps,
  mimicId: string,
  candidateId: string | null,
): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  // Only a candidate from the latest search can be confirmed; earlier ones are superseded or already decided.
  const open = (await deps.store.listCandidates(m.id)).filter((c) => c.status === 'proposed');
  const chosen = candidateId ? open.find((c) => c.id === candidateId) : undefined;
  if (candidateId && !chosen) throw new EngineError('not_found', 'Candidate not found');
  if (!chosen) {
    await deps.store.setCandidateStatus(
      m.id,
      open.map((c) => c.id),
      'rejected',
    );
    await finishIdentity(deps, m.id);
    return;
  }
  const now = deps.clock();
  // Claimed in one statement: a search again (or another tab) that moved on first wins.
  if (
    !(await deps.store.transitionIdentity(m.id, ['candidates'], {
      identityState: 'enriching',
      updatedAt: now,
    }))
  ) {
    throw new EngineError('conflict', NOT_WAITING);
  }
  await deps.store.setCandidateStatus(
    m.id,
    open.filter((c) => c.id !== chosen.id).map((c) => c.id),
    'rejected',
  );
  await deps.store.setCandidateStatus(m.id, [chosen.id], 'confirmed');
  const facts: FactRecord[] = [];
  if (chosen.headline) facts.push(fact(deps, m.id, 'headline', chosen.headline, chosen.url, 0.8, now));
  if (chosen.location) facts.push(fact(deps, m.id, 'livesIn', chosen.location, chosen.url, 0.7, now));
  await addFacts(deps, m, facts);
  await deps.jobs.enqueue({ type: 'identity.enrich', mimicId: m.id, candidateId: chosen.id });
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
    userStateAt: null,
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
  const ok = await deps.store.updateFact(mimicId, factId, { userState, userStateAt: deps.clock() });
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
