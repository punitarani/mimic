import type { FidelityResult } from '../fidelity';
import { getFacetGroups } from '../ontology';
import type { MimicScope } from '../scope';
import { facetCoverage } from '../selectors';
import { toStateEvidence } from '../state-builder';
import type { FactRecord, IdentityState, KgEdgeRecord, KgNodeRecord, MimicStatus } from '../store';
import { type Insight, isScoredKind, isSessionKind } from '../types';
import { facetCounts, loadMimicData } from './data';
import { capsFor, type EngineDeps, facetsFor, loadConfig, requireMimic } from './deps';
import { citedSeqs } from './rewind';
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
    /** What the person agreed to be asked about (ADR-0040), and when it last narrowed. */
    scope: MimicScope;
    scopeAt: number | null;
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
  /** `basics`: the anchors seeded for this person; the panel shows "Learning the basics" until they are answered. */
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
  kg: { nodes: UiKgNode[]; edges: UiKgEdge[] };
  unexplored: string[];
  pool: { pooled: number; low: boolean };
}

/** A KG node. The optional fields are provenance for the map's tooltips (ADR-0046); older snapshots lack them. */
export interface UiKgNode {
  id: string;
  type: string;
  label: string;
  /** Where the node came from: `search`, `reflection` or `intake`. */
  source?: string;
  url?: string;
  facetId?: string;
}

/** A stored KG edge (every one runs from the person node); the map infers the links between entities. */
export interface UiKgEdge {
  src: string;
  dst: string;
  predicate: string;
  /** The fact's or insight's confidence. */
  weight: number;
  source?: string;
  url?: string;
  /** Answer seqs the fact or insight cites. */
  evidence?: number[];
  /** For `exhibits`: the insight's ID and text. */
  ref?: string;
  note?: string;
}

export const KG_MAX_NODES = 60;

/**
 * The KG as the map shows it: edges whose fact the person removed or the scope hides (ADR-0040), or whose insight is
 * no longer active or in scope, are gone; so are blocked facets and nodes left without an edge. The cap keeps the
 * most confident nodes rather than the oldest.
 */
export function uiKg(
  kg: { nodes: KgNodeRecord[]; edges: KgEdgeRecord[] },
  /** Fact rows within the scope (removed ones included). */
  facts: FactRecord[],
  /** Insights that are active and within the scope. */
  activeInsights: Array<Pick<Insight, 'id' | 'text' | 'evidenceSeqs'>>,
  /** Facets the scope blocks. */
  blocked: ReadonlySet<string> = new Set(),
): UiSnapshot['kg'] {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const insightById = new Map(activeInsights.map((i) => [i.id, i]));
  const edges: UiKgEdge[] = [];
  for (const e of kg.edges) {
    const out: UiKgEdge = {
      src: e.src,
      dst: e.dst,
      predicate: e.predicate,
      weight: e.weight,
      source: e.source,
    };
    const f = e.sourceRef ? factById.get(e.sourceRef) : undefined;
    const i = e.sourceRef ? insightById.get(e.sourceRef) : undefined;
    if (e.predicate === 'exhibits') {
      if (!i) continue;
      out.evidence = [...i.evidenceSeqs];
      out.ref = i.id;
      out.note = i.text;
    } else if (e.sourceRef) {
      // A fact edge whose fact isn't here is out of scope (or gone): only a legacy edge with no ref stays unchecked.
      if (f?.userState !== 'active') continue;
      if (f.sourceUrl) out.url = f.sourceUrl;
      const seqs = citedSeqs(f.sourceRef);
      if (seqs.length) out.evidence = seqs;
    }
    edges.push(out);
  }
  const best = new Map<string, number>();
  for (const e of edges) {
    for (const id of [e.src, e.dst]) best.set(id, Math.max(best.get(id) ?? 0, e.weight));
  }
  const nodes = kg.nodes
    .map((n, order) => ({ n, order }))
    .filter(({ n }) => n.type === 'Person' || best.has(n.id))
    .filter(({ n }) => !(typeof n.props.facetId === 'string' && blocked.has(n.props.facetId)))
    .sort(
      (a, b) =>
        Number(b.n.type === 'Person') - Number(a.n.type === 'Person') ||
        (best.get(b.n.id) ?? 0) - (best.get(a.n.id) ?? 0) ||
        a.order - b.order,
    )
    .slice(0, KG_MAX_NODES)
    .sort((a, b) => a.order - b.order)
    .map(({ n }): UiKgNode => {
      const out: UiKgNode = { id: n.id, type: n.type, label: n.label, source: n.source };
      if (typeof n.props.url === 'string') out.url = n.props.url;
      if (typeof n.props.facetId === 'string') out.facetId = n.props.facetId;
      return out;
    });
  const nodeIds = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst)) };
}

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
  // Answers the scope hides count nowhere, not even toward coverage (ADR-0043).
  const visible = loaded.questions.filter((q) => !loaded.scope.hiddenQuestionIds.has(q.id));
  const counts = facetCounts(visible);
  const answeredQ = new Map(loaded.answers.map((a) => [a.questionId, a.seq]));
  const supporting = new Map<string, number[]>();
  for (const q of visible) {
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
  const latest = fid.at(-1);
  const pooled = visible.filter((q) => q.kind === 'adaptive' && q.status === 'pooled').length;
  // The anchors actually seeded: a person who deselected a category gets fewer (ADR-0040).
  const basics = visible.filter((q) => q.kind === 'anchor').length;
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
      scope: m.scope,
      scopeAt: m.scopeAt,
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
      basics,
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
    kg: uiKg(kg, loaded.facts, loaded.data.insights, loaded.scope.blocked),
    unexplored: uiFacets.filter((f) => f.coverage === 0).map((f) => f.id),
    pool: { pooled, low: pooled < MIN_POOL },
  };
}
