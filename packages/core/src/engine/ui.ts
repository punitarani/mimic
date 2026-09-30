import type { FidelityResult } from '../fidelity';
import { getFacetGroups } from '../ontology';
import { facetCoverage } from '../selectors';
import { toStateEvidence } from '../state-builder';
import type { IdentityState, MimicStatus } from '../store';
import { isScoredKind, isSessionKind } from '../types';
import { facetCounts, loadMimicData } from './data';
import { capsFor, type EngineDeps, facetsFor, loadConfig, requireMimic } from './deps';
import { fidelityFromRecord, MIN_POOL } from './session';

export interface UiFacet {
  id: string;
  group: string;
  name: string;
  low: string;
  high: string;
  /** Five readings, low → high, for the facet's current position. */
  labels: [string, string, string, string, string];
  mean: number | null;
  /** Jev's confidence in the trait read — shown as "certainty", never accuracy (PLAN §9.10). */
  certainty: number | null;
  coverage: number;
  supporting: number[];
}

export interface UiSnapshot {
  mimic: {
    id: string;
    displayName: string;
    location: string;
    occupation: string | null;
    employer: string | null;
    status: MimicStatus;
    identityState: IdentityState;
    consentSearch: boolean;
    consentResearch: boolean;
    reveal: 'after_answer' | 'never';
    arm: string | null;
    createdAt: number;
    spendUsd: number;
    /**
     * The whole cap: asking, teaching and SOUL.md work until spend reaches it. The session stops earlier, at its
     * share, and says so through `/next` (ADR-0035).
     */
    budgetUsd: number;
    snapshotVersion: number;
  };
  /** `basics`: the anchor battery size; the panel shows "Learning the basics" until that many are answered. */
  progress: { answered: number; target: number; basics: number };
  fidelity: FidelityResult | null;
  history: Array<{
    seq: number;
    fidelity: number;
    acc: number;
    accBaseline: number | null;
    selfConsistency: number;
    ciLow: number;
    ciHigh: number;
  }>;
  facets: UiFacet[];
  groups: string[];
  insights: Array<{
    id: string;
    text: string;
    facetIds: string[];
    evidence: Array<{ seq: number; q: string; answer: string }>;
  }>;
  kg: {
    nodes: Array<{ id: string; type: string; label: string }>;
    edges: Array<{ src: string; dst: string; predicate: string; weight: number }>;
  };
  unexplored: string[];
  pool: { pooled: number; low: boolean };
}

export const KG_MAX_NODES = 60;

/** `GET /api/mimics/:id` — everything the session page and model panel render. */
export async function uiSnapshot(deps: EngineDeps, mimicId: string): Promise<UiSnapshot> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  const [loaded, fid, kg, facets] = await Promise.all([
    loadMimicData(deps, m),
    deps.store.listFidelity(m.id),
    deps.store.listKg(m.id),
    facetsFor(deps, m, cfg),
  ]);
  const counts = facetCounts(loaded.questions);
  const answeredQ = new Map(loaded.answers.map((a) => [a.questionId, a.seq]));
  const supporting = new Map<string, number[]>();
  for (const q of loaded.questions) {
    const seq = answeredQ.get(q.id);
    if (seq === undefined || !isScoredKind(q.kind)) continue;
    for (const f of q.facetIds) supporting.set(f, [...(supporting.get(f) ?? []), seq]);
  }
  const jevTraits = new Map(loaded.data.traits.filter((t) => t.method === 'jev').map((t) => [t.facetId, t]));
  const psych = new Map(
    loaded.data.traits.filter((t) => t.method === 'psychometric').map((t) => [t.facetId, t]),
  );
  const uiFacets: UiFacet[] = facets.map((f) => {
    const t = jevTraits.get(f.id) ?? psych.get(f.id);
    return {
      id: f.id,
      group: f.group,
      name: f.name,
      low: f.low,
      high: f.high,
      labels: f.labels,
      mean: t ? t.mean : null,
      certainty: t ? t.confidence : null,
      coverage: facetCoverage(counts, f.id),
      supporting: (supporting.get(f.id) ?? []).sort((a, b) => a - b),
    };
  });
  const evidenceBySeq = new Map(loaded.data.evidence.map((e) => [e.seq, toStateEvidence(e)]));
  const insights = loaded.data.insights
    .sort((a, b) => b.seqUpTo - a.seqUpTo)
    .slice(0, 12)
    .map((i) => ({
      id: i.id,
      text: i.text,
      facetIds: i.facetIds,
      evidence: i.evidenceSeqs
        .map((s) => evidenceBySeq.get(s))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({ seq: e.seq, q: e.q, answer: e.answer })),
    }));
  const nodes = kg.nodes.slice(0, KG_MAX_NODES);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const latest = fid.at(-1);
  const pooled = loaded.questions.filter((q) => q.kind === 'adaptive' && q.status === 'pooled').length;
  return {
    mimic: {
      id: m.id,
      displayName: m.displayName,
      location: m.location,
      occupation: m.occupation,
      employer: m.employer,
      status: m.status,
      identityState: m.identityState,
      consentSearch: m.consentSearch,
      consentResearch: m.consentResearch,
      reveal: cfg.reveal,
      arm: m.arm,
      createdAt: m.createdAt,
      spendUsd: m.spendUsd,
      budgetUsd: capsFor(deps, cfg).totalUsd,
      snapshotVersion: m.snapshotVersion,
    },
    progress: {
      answered: loaded.questions.filter((q) => q.status === 'answered' && isSessionKind(q.kind)).length,
      target: cfg.session.target,
      basics: cfg.anchors.count,
    },
    fidelity: latest ? fidelityFromRecord(latest) : null,
    history: fid.map((f) => ({
      seq: f.seqUpTo,
      fidelity: f.fidelity,
      acc: f.acc,
      accBaseline: f.accBaseline,
      selfConsistency: f.selfConsistency,
      ciLow: f.ciLow,
      ciHigh: f.ciHigh,
    })),
    facets: uiFacets,
    groups: getFacetGroups(cfg.ontologyVersion),
    insights,
    kg: {
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })),
      edges: kg.edges
        .filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
        .map((e) => ({ src: e.src, dst: e.dst, predicate: e.predicate, weight: e.weight })),
    },
    unexplored: uiFacets.filter((f) => f.coverage === 0).map((f) => f.id),
    pool: { pooled, low: pooled < MIN_POOL },
  };
}
