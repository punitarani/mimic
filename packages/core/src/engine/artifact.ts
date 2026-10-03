import { z } from 'zod';
import { factHidden } from '../scope';
import type { FactRecord, FidelityRecord, MimicRecord, QuestionRecord } from '../store';
import { StaleEvidenceError } from '../store';
import { QKind } from '../types';
import { type LoadedMimic, loadMimicData, scopedKg, vectorId } from './data';
import { type EngineDeps, EngineError, loadConfig, requireMimic } from './deps';
import { searchCacheKeys } from './identity';

/** The persisted, portable mimic (PLAN §8.1). */
export const MimicJson = z.object({
  schema: z.literal('mimic/1'),
  mimicId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.number().int(),
  seqUpTo: z.number().int().min(0),
  subject: z.object({ displayName: z.string(), location: z.string(), occupation: z.string().nullable() }),
  facts: z.array(
    z.object({
      predicate: z.string(),
      object: z.string(),
      source: z.enum(['intake', 'search', 'answer', 'reflection']),
      url: z.string().nullable(),
      confidence: z.number(),
    }),
  ),
  evidence: z.array(
    z.object({
      seq: z.number().int(),
      kind: QKind,
      type: z.enum(['choice', 'noul', 'score']),
      prompt: z.string(),
      options: z.array(z.string()),
      optionKeys: z.array(z.string()),
      answer: z.string(),
      why: z.string().nullable(),
      /**
       * Where the answer came from (ADR-0060): `session` (asked by Mimic), `person` (taught on the mimic page) or
       * `agent` (an observation another agent appended), with the agent's name. Absent in files written before it.
       */
      source: z.enum(['session', 'person', 'agent']).optional(),
      agent: z.string().optional(),
    }),
  ),
  traits: z.array(
    z.object({
      facet: z.string(),
      method: z.enum(['jev', 'psychometric']),
      mean: z.number(),
      dist: z.record(z.string(), z.number()),
      confidence: z.number(),
      n: z.number().int(),
    }),
  ),
  insights: z.array(
    z.object({ text: z.string(), facets: z.array(z.string()), evidence: z.array(z.number().int()) }),
  ),
  kg: z.object({
    nodes: z.array(z.object({ id: z.string(), type: z.string(), label: z.string() })),
    edges: z.array(z.object({ src: z.string(), dst: z.string(), predicate: z.string(), weight: z.number() })),
  }),
  fidelity: z
    .object({
      fidelity: z.number(),
      ci: z.tuple([z.number(), z.number()]),
      acc: z.number(),
      accBaseline: z.number().nullable(),
      selfConsistency: z.number(),
      n: z.number().int(),
    })
    .nullable(),
  pipeline: z.object({
    configHash: z.string(),
    config: z.unknown(),
    models: z.object({ primary: z.string().nullable() }),
  }),
});
export type MimicJson = z.infer<typeof MimicJson>;

/** The origin of an answer, from its question's provenance (ADR-0060). */
export function evidenceOrigin(q: Pick<QuestionRecord, 'kind' | 'provenance'>): {
  source: 'session' | 'person' | 'agent';
  agent?: string;
} {
  if (q.kind !== 'feedback') return { source: 'session' };
  const g = q.provenance.generator;
  return g.startsWith('observation:')
    ? { source: 'agent', agent: g.slice('observation:'.length) }
    : { source: 'person' };
}

/**
 * Unique per write attempt: two writers racing for the same version can never overwrite a committed snapshot's
 * blob (snapshots are immutable). The D1 row records the key; hard delete removes the whole prefix.
 */
export function snapshotKey(mimicId: string, version: number, attemptId: string): string {
  return `snapshots/${mimicId}/v${version}-${attemptId}.json`;
}

/** The fields of `mimic.json` that describe the person, from the mimic's current data (facts: active only). */
export type MimicDocParts = Pick<
  MimicJson,
  'seqUpTo' | 'subject' | 'facts' | 'evidence' | 'traits' | 'insights' | 'fidelity'
>;

export function mimicDocParts(
  m: MimicRecord,
  loaded: LoadedMimic,
  facts: FactRecord[],
  fid: FidelityRecord[],
): MimicDocParts {
  const seqUpTo = loaded.answers.reduce((a, x) => Math.max(a, x.seq), 0);
  const latestFid = fid.at(-1);
  const qById = new Map(loaded.questions.map((q) => [q.id, q]));
  return {
    seqUpTo,
    subject: { displayName: m.displayName, location: m.location, occupation: m.occupation },
    facts: facts
      .filter((f) => f.userState === 'active' && !factHidden(loaded.scope, f))
      .map((f) => ({
        predicate: f.predicate,
        object: f.object,
        source: f.source,
        url: f.sourceUrl,
        confidence: f.confidence,
      })),
    evidence: loaded.answers
      .filter((a) => !loaded.scope.hiddenQuestionIds.has(a.questionId))
      .map((a) => {
        const q = qById.get(a.questionId)!;
        const origin = evidenceOrigin(q);
        return {
          seq: a.seq,
          kind: q.kind,
          type: q.type,
          prompt: q.prompt,
          options: q.options.map((o) => o.label),
          optionKeys: q.options.map((o) => o.key),
          answer: a.value,
          why: a.why,
          source: origin.source,
          ...(origin.agent ? { agent: origin.agent } : {}),
        };
      })
      .sort((a, b) => a.seq - b.seq),
    traits: loaded.data.traits.map((t) => ({
      facet: t.facetId,
      method: t.method,
      mean: t.mean,
      dist: t.dist,
      confidence: t.confidence,
      n: t.nEvidence,
    })),
    insights: loaded.data.insights.map((i) => ({
      text: i.text,
      facets: i.facetIds,
      evidence: i.evidenceSeqs,
    })),
    fidelity: latestFid
      ? {
          fidelity: latestFid.fidelity,
          ci: [latestFid.ciLow, latestFid.ciHigh],
          acc: latestFid.acc,
          accBaseline: latestFid.accBaseline,
          selfConsistency: latestFid.selfConsistency,
          n: latestFid.nScored,
        }
      : null,
  };
}

export async function buildMimicJson(deps: EngineDeps, mimicId: string, version: number): Promise<MimicJson> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const loaded = await loadMimicData(deps, m);
  const [facts, kg, fid, primaries] = await Promise.all([
    deps.store.listFacts(m.id),
    deps.store.listKg(m.id),
    deps.store.listFidelity(m.id),
    deps.store.listPredictions({ mimicId: m.id, roles: ['primary'] }),
  ]);
  const lastPrimary = primaries.filter((p) => p.ok && !p.fallback).at(-1);
  const parts = mimicDocParts(m, loaded, facts, fid);
  const graph = scopedKg(kg, loaded);
  const doc: MimicJson = {
    schema: 'mimic/1',
    mimicId: m.id,
    version,
    createdAt: deps.clock(),
    ...parts,
    kg: {
      nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })),
      edges: graph.edges.map((e) => ({ src: e.src, dst: e.dst, predicate: e.predicate, weight: e.weight })),
    },
    pipeline: {
      configHash: m.configHash,
      config: cfg,
      models: { primary: lastPrimary?.modelSnapshot ?? null },
    },
  };
  return MimicJson.parse(doc);
}

/**
 * Writes an immutable snapshot unless the latest one already holds every answer (this is what debounces learning
 * bursts). Answers are append-only, so the same count and a seq at least as high mean the same answers. The count
 * matters because answers don't always arrive in seq order: an asked question on the mimic page can be answered
 * while a session question below it is still open.
 */
export async function writeSnapshot(
  deps: EngineDeps,
  mimicId: string,
  seqUpTo?: number,
): Promise<number | null> {
  // One retry: an undo that lands while the snapshot is built refuses it (it read the retracted answer).
  try {
    return await writeSnapshotOnce(deps, mimicId, seqUpTo);
  } catch (e) {
    if (!(e instanceof StaleEvidenceError)) throw e;
    return writeSnapshotOnce(deps, mimicId, seqUpTo);
  }
}

async function writeSnapshotOnce(
  deps: EngineDeps,
  mimicId: string,
  seqUpTo?: number,
): Promise<number | null> {
  const m = await requireMimic(deps, mimicId);
  // Taken before reading, so a snapshot's createdAt never claims data newer than what it read.
  const asOf = deps.clock();
  const [snaps, answers, rewinds] = await Promise.all([
    deps.store.listSnapshots(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listAnswerRewinds(m.id),
  ]);
  const latest = snaps.at(-1);
  const currentSeq = answers.reduce((a, x) => Math.max(a, x.seq), 0);
  // A snapshot taken before an undo still holds the retracted answer, even with the same count and seq (ADR-0036).
  const lastRewind = rewinds.reduce((a, r) => Math.max(a, r.rewoundAt), 0);
  if (
    latest &&
    latest.seqUpTo >= Math.max(seqUpTo ?? 0, currentSeq) &&
    latest.createdAt > lastRewind &&
    (await snapshotAnswerCount(deps, latest.r2Key)) === answers.length
  )
    return null;
  const version = (latest?.version ?? 0) + 1;
  const doc = await buildMimicJson(deps, m.id, version);
  const key = snapshotKey(m.id, version, deps.newId());
  await deps.blobs.put(key, JSON.stringify(doc), 'application/json');
  try {
    // Guarded by the epoch read above, so a snapshot built before an undo is never recorded after it.
    await deps.store.guarded(m.id, m.evidenceEpoch).insertSnapshot({
      mimicId: m.id,
      version,
      r2Key: key,
      seqUpTo: doc.seqUpTo,
      createdAt: asOf,
    });
  } catch (e) {
    // Another writer took this version (primary key), or an undo landed; drop our blob.
    await deps.blobs.delete([key]);
    throw e;
  }
  await deps.store.updateMimic(m.id, { snapshotVersion: version, updatedAt: deps.clock() });
  return version;
}

async function snapshotAnswerCount(deps: EngineDeps, key: string): Promise<number | null> {
  try {
    const raw = await deps.blobs.get(key);
    return raw ? ((JSON.parse(raw) as { evidence?: unknown[] }).evidence?.length ?? null) : null;
  } catch {
    return null;
  }
}

/** `GET /export`: the latest snapshot, written fresh if evidence moved past it. */
export async function exportMimic(deps: EngineDeps, mimicId: string): Promise<MimicJson> {
  await writeSnapshot(deps, mimicId);
  const latest = (await deps.store.listSnapshots(mimicId)).at(-1);
  if (!latest) throw new EngineError('not_found', 'No snapshot');
  const raw = await deps.blobs.get(latest.r2Key);
  if (!raw) throw new EngineError('not_found', 'Snapshot blob missing');
  return MimicJson.parse(JSON.parse(raw));
}

/** Hard delete across D1, R2, Vectorize and KV (PLAN §11, §15). */
export async function deleteMimic(deps: EngineDeps, mimicId: string): Promise<void> {
  const m = await requireMimic(deps, mimicId);
  const [questions, answers, facts, calls] = await Promise.all([
    deps.store.listQuestions(m.id),
    deps.store.listAnswers(m.id),
    deps.store.listFacts(m.id),
    deps.store.listModelCalls({ mimicId: m.id, limit: 100_000 }),
  ]);
  const vecIds = [
    ...answers.map((a) => vectorId.qa(m.id, a.seq)),
    ...facts.map((f) => vectorId.fact(m.id, f.id)),
    ...questions.map((q) => vectorId.question(m.id, q.id)),
  ];
  for (let i = 0; i < vecIds.length; i += 100) await deps.vectors.deleteByIds(vecIds.slice(i, i + 100));

  const blobKeys = calls.map((c) => c.r2TraceKey);
  for (const prefix of [`snapshots/${m.id}/`, `search/${m.id}/`, `states/${m.id}/`]) {
    blobKeys.push(...(await deps.blobs.list(prefix)));
  }
  for (let i = 0; i < blobKeys.length; i += 500) await deps.blobs.delete(blobKeys.slice(i, i + 500));

  await deps.kv.delete(`hyp:${m.id}`);
  for (const k of searchCacheKeys(m)) await deps.kv.delete(k);
  for (const k of await deps.kv.list(`mimic:${m.id}:`)) await deps.kv.delete(k);

  await deps.store.deleteMimic(m.id);
}

/**
 * Hard-deletes a person: every mimic they own (each through `deleteMimic`, so D1, R2, Vectorize and KV), then their
 * participant row. Used by `/lab/mimics` (ADR-0076).
 */
export async function deleteParticipant(
  deps: EngineDeps,
  participantId: string,
): Promise<{ mimics: number }> {
  const mimics = await deps.store.listMimics({ participantId });
  for (const m of mimics) await deleteMimic(deps, m.id);
  await deps.store.deleteParticipant(participantId);
  return { mimics: mimics.length };
}
