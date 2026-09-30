import type { UiSnapshot } from '@mimic/core';
import { hostLabel } from '@mimic/core/links';
import { type Facet, readingOf, sentence } from '../session-view';
import {
  entityLabel,
  isSchoolLike,
  isVague,
  normKey,
  orgKey,
  parseWork,
  placeKey,
  placeParts,
  sentenceCase,
  splitList,
  tidy,
  tokens,
} from './clean';

/**
 * The map's graph model (ADR-0046). The stored KG is a star: every fact is an edge from the person. This turns it
 * into a network of the things themselves: labels are split and deduped, each node gets one category, and edges
 * between entities are inferred from what the facts share (a source profile, a list, answers they cite, an insight
 * that names both). The person node is dropped: the whole map is theirs.
 */

export type Category = 'work' | 'place' | 'interest' | 'skill' | 'trait';

/** Legend order; the layout places clusters around a ring in `RING` order instead. */
export const CATEGORIES: ReadonlyArray<{ id: Category; label: string }> = [
  { id: 'work', label: 'Work' },
  { id: 'place', label: 'Places' },
  { id: 'interest', label: 'Interests' },
  { id: 'skill', label: 'Skills' },
  { id: 'trait', label: 'Traits' },
];

export type NodeKind = 'Role' | 'Company' | 'School' | 'Place' | 'Skill' | 'Interest' | 'Trait';

export interface MapNode {
  /** Stable across sessions: namespace and dedupe key, so the layout is too. */
  id: string;
  label: string;
  /** The label on the map, when shorter: a place's city. The tooltip shows `label`. */
  short: string;
  category: Category;
  kind: NodeKind;
  /** Highest confidence of the facts or insights behind it, 0–1. */
  confidence: number;
  /** One line for the tooltip: "Current employer", "Listed under Frameworks", an insight. */
  description: string;
  /** Traits only: the current reading, e.g. "Leans organized". */
  reading?: string;
  /** Where it came from: profile hosts, "Your answers". */
  sources: string[];
  /** Answer seqs behind it. */
  evidence: number[];
}

export type EdgeKind =
  | 'role-at'
  | 'holds'
  | 'related-role'
  | 'uses'
  | 'listed-with'
  | 'based-in'
  | 'located-in'
  | 'evidence'
  | 'shared-evidence'
  | 'co-insight'
  | 'stored';

export const EDGE_PHRASE: Record<EdgeKind, string> = {
  'role-at': 'role and company',
  holds: 'current role',
  'related-role': 'related role',
  uses: 'skill in this role',
  'listed-with': 'listed together',
  'based-in': 'same profile',
  'located-in': 'located there',
  evidence: 'same answers',
  'shared-evidence': 'same answers',
  'co-insight': 'same insight',
  stored: 'linked',
};

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Confidence of the link, 0–1: never more than its weaker end's. */
  weight: number;
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

type Namespace = 'role' | 'org' | 'place' | 'topic' | 'trait';

interface Mention {
  ns: Namespace;
  key: string;
  aliases: string[];
  kind: NodeKind;
  label: string;
  conf: number;
  description: string;
  rank: number;
  source: string | undefined;
  url: string | undefined;
  evidence: number[];
  current: boolean;
  /** List membership: a split label, or one profile's history of one kind (schools, past employers). */
  group?: { id: string; index: number };
  facetId?: string;
  insights: Array<{ id: string; conf: number; evidence: number[] }>;
}

interface Pair {
  a: Mention;
  b: Mention;
  kind: EdgeKind;
  weight: number;
}

type RawEdge = UiSnapshot['kg']['edges'][number];

/** Description priority when mentions merge: the more specific wins. */
const RANK = { current: 4, school: 3, past: 2, plain: 1 } as const;

function mentionsOf(
  node: UiSnapshot['kg']['nodes'][number],
  order: number,
  edges: RawEdge[],
  facetById: Map<string, Facet>,
  pairs: Pair[],
): Mention[] {
  const strongest = edges.reduce((a, b) => (b.weight > a.weight ? b : a));
  // Two facts naming the same thing (a headline and a job title, a location twice) corroborate each other.
  const conf = Math.min(0.95, strongest.weight + 0.05 * (edges.length - 1));
  const url = node.url ?? edges.find((e) => e.url)?.url;
  const evidence = [...new Set(edges.flatMap((e) => e.evidence ?? []))].sort((a, b) => a - b);
  const base = { conf, source: node.source ?? strongest.source, url, evidence, insights: [] };
  const preds = new Set(edges.map((e) => e.predicate));
  switch (node.type) {
    case 'Organization':
    case 'Occupation': {
      const parts = parseWork(node.label, node.type === 'Organization' ? 'org' : 'role');
      const current = preds.has('worksFor') || (node.type === 'Occupation' && base.source === 'search');
      const history = (['alumniOf', 'workedFor'] as const).find((p) => preds.has(p));
      const out: Mention[] = [];
      let org: Mention | undefined;
      if (parts.org && !isVague(parts.org)) {
        const school = preds.has('alumniOf') || isSchoolLike(parts.org);
        const rank = preds.has('worksFor') ? RANK.current : school ? RANK.school : RANK.past;
        org = {
          ...base,
          ns: 'org',
          key: orgKey(parts.org),
          aliases: parts.aliases.map(orgKey).filter(Boolean),
          kind: school ? 'School' : 'Company',
          label: parts.org,
          description: rank === RANK.current ? 'Current employer' : school ? 'School' : 'Past employer',
          rank,
          current: preds.has('worksFor'),
        };
        if (history && url) org.group = { id: `${history}|${url}`, index: order };
        out.push(org);
      }
      for (const role of parts.roles) {
        if (isVague(role)) continue;
        const r: Mention = {
          ...base,
          ns: 'role',
          key: normKey(role),
          aliases: [],
          kind: 'Role',
          label: role,
          description: org ? `Role at ${org.label}` : current ? 'Current role' : 'Role',
          rank: current ? RANK.current : RANK.plain,
          current,
        };
        out.push(r);
        if (org) pairs.push({ a: r, b: org, kind: 'role-at', weight: conf });
      }
      return out;
    }
    case 'Place': {
      const label = placeParts(node.label).join(', ');
      if (!label || isVague(label)) return [];
      return [
        {
          ...base,
          ns: 'place',
          key: placeKey(label),
          aliases: [],
          kind: 'Place',
          label,
          description: preds.has('homeLocation') ? 'Where you live' : 'Place',
          rank: RANK.plain,
          current: preds.has('homeLocation'),
        },
      ];
    }
    case 'Skill':
    case 'Interest': {
      const kind = node.type;
      const { subtype, items } = splitList(node.label);
      const out: Mention[] = [];
      items.forEach((item, index) => {
        const label = sentenceCase(entityLabel(item));
        if (isVague(label)) return;
        const m: Mention = {
          ...base,
          ns: 'topic',
          key: normKey(label),
          aliases: [],
          kind,
          label,
          description: subtype ? sentence(subtype) : kind,
          rank: subtype ? RANK.school : RANK.plain,
          current: false,
        };
        if (items.length > 1) m.group = { id: node.id, index };
        out.push(m);
      });
      return out;
    }
    case 'Facet': {
      const facetId = node.facetId ?? node.id.split(':').at(-1) ?? node.id;
      const facet = facetById.get(facetId);
      const exhibits = edges.filter((e) => e.predicate === 'exhibits');
      const top = [...exhibits].sort((a, b) => b.weight - a.weight)[0];
      const support = facet?.supporting ?? [];
      const m: Mention = {
        ...base,
        evidence: [...new Set([...evidence, ...support])].sort((a, b) => a - b),
        ns: 'trait',
        key: facetId,
        aliases: [],
        kind: 'Trait',
        label: sentence(facet?.name ?? node.label),
        description: top?.note ?? 'A trait your answers point to',
        rank: RANK.plain,
        current: false,
        facetId,
        insights: exhibits.map((e) => ({
          id: e.ref ?? e.note ?? '',
          conf: e.weight,
          evidence: e.evidence ?? [],
        })),
      };
      return [m];
    }
    default:
      return [];
  }
}

const CATEGORY_OF: Record<NodeKind, Category> = {
  Role: 'work',
  Company: 'work',
  School: 'work',
  Place: 'place',
  Skill: 'skill',
  Interest: 'interest',
  Trait: 'trait',
};

/** Merges mentions of one thing into a node, and gives every mention the node's id. */
function mergeMentions(mentions: Mention[], facetById: Map<string, Facet>) {
  const idOf = new Map<Mention, string>();
  const byKey = new Map<string, Mention[]>();
  const alias = new Map<string, string>();
  for (const m of mentions) {
    const own = `${m.ns}:${m.key}`;
    // Its own key first, then a key an earlier mention gave as an alias ("Handshake AI" after "Handshake (Handshake
    // AI)"), then its aliases naming an earlier mention (the reverse order).
    const target = byKey.has(own)
      ? own
      : (alias.get(own) ?? m.aliases.map((a) => alias.get(`${m.ns}:${a}`)).find(Boolean) ?? own);
    byKey.set(target, [...(byKey.get(target) ?? []), m]);
    idOf.set(m, target);
    for (const a of [m.key, ...m.aliases]) if (!alias.has(`${m.ns}:${a}`)) alias.set(`${m.ns}:${a}`, target);
  }
  const nodes: MapNode[] = [];
  const current = new Set<string>();
  for (const [id, group] of byKey) {
    if (group.some((m) => m.current)) current.add(id);
    const best = [...group].sort((a, b) => b.conf - a.conf || b.label.length - a.label.length)[0]!;
    const described = [...group].sort((a, b) => b.rank - a.rank || b.conf - a.conf)[0]!;
    // A topic named as both a skill and an interest is a skill.
    const kind = group.some((m) => m.kind === 'Skill')
      ? 'Skill'
      : group.some((m) => m.kind === 'School')
        ? 'School'
        : best.kind;
    const sources = new Set<string>();
    for (const m of group) {
      if (m.url) sources.add(hostLabel(m.url));
      else if (m.source === 'reflection' || m.evidence.length) sources.add('Your answers');
      else if (m.source === 'intake') sources.add('You, at sign-up');
      else if (m.source === 'search') sources.add('Public profile');
    }
    const distinctSources = new Set(group.map((m) => m.url ?? m.source)).size;
    const node: MapNode = {
      id,
      label: best.label,
      short: kind === 'Place' ? (placeParts(best.label)[0] ?? best.label) : best.label,
      category: CATEGORY_OF[kind],
      kind,
      confidence: Math.min(0.95, Math.max(...group.map((m) => m.conf)) + 0.05 * (distinctSources - 1)),
      description: described.description,
      sources: [...sources],
      evidence: [...new Set(group.flatMap((m) => m.evidence))].sort((a, b) => a - b),
    };
    const facet = best.facetId ? facetById.get(best.facetId) : undefined;
    if (facet && facet.mean !== null) node.reading = sentence(readingOf(facet));
    nodes.push(node);
  }
  return { nodes, idOf, current };
}

const overlap = (a: number[], b: number[]) => {
  const s = new Set(a);
  return b.filter((x) => s.has(x)).length;
};

const jaccard = (a: number[], b: number[]) => {
  const n = overlap(a, b);
  return n ? n / (a.length + b.length - n) : 0;
};

/** Keeps each node's strongest `max` edges of the kinds given, among the candidates. */
function capPerNode(cands: MapEdge[], max: number): MapEdge[] {
  const count = new Map<string, number>();
  const out: MapEdge[] = [];
  for (const e of [...cands].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))) {
    if ((count.get(e.source) ?? 0) >= max || (count.get(e.target) ?? 0) >= max) continue;
    count.set(e.source, (count.get(e.source) ?? 0) + 1);
    count.set(e.target, (count.get(e.target) ?? 0) + 1);
    out.push(e);
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

const listText = (xs: string[]) =>
  xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/** Builds the map's graph from the snapshot's KG (and facets, for trait readings and evidence). */
export function buildGraph(kg: UiSnapshot['kg'], facets: Facet[] = []): MapGraph {
  const facetById = new Map(facets.map((f) => [f.id, f]));
  const byId = new Map(kg.nodes.map((n) => [n.id, n]));
  const isPerson = (id: string) => byId.get(id)?.type === 'Person';
  const incident = new Map<string, RawEdge[]>();
  for (const e of kg.edges) {
    for (const id of [e.src, e.dst]) {
      if (!isPerson(id)) incident.set(id, [...(incident.get(id) ?? []), e]);
    }
  }
  const pairs: Pair[] = [];
  const mentionsByRaw = new Map<string, Mention[]>();
  const mentions: Mention[] = [];
  for (const [order, n] of kg.nodes.entries()) {
    const es = incident.get(n.id);
    if (!es?.length || n.type === 'Person') continue;
    const ms = mentionsOf(n, order, es, facetById, pairs);
    mentionsByRaw.set(n.id, ms);
    mentions.push(...ms);
  }
  const { nodes, idOf, current } = mergeMentions(mentions, facetById);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const conf = (id: string) => nodeById.get(id)?.confidence ?? 0;
  const edges = new Map<string, MapEdge>();
  const add = (a: string, b: string, kind: EdgeKind, weight: number) => {
    if (a === b) return;
    const [source, target] = a < b ? [a, b] : [b, a];
    const id = `${source}|${target}`;
    const w = r2(Math.min(weight, conf(a), conf(b)));
    const prev = edges.get(id);
    if (!prev || prev.weight < w) edges.set(id, { id, source, target, kind, weight: w });
  };
  const addAll = (es: MapEdge[]) => {
    for (const e of es) add(e.source, e.target, e.kind, e.weight);
  };
  const cand = (a: string, b: string, kind: EdgeKind, weight: number): MapEdge => {
    const [source, target] = a < b ? [a, b] : [b, a];
    return {
      id: `${source}|${target}`,
      source,
      target,
      kind,
      weight: r2(Math.min(weight, conf(a), conf(b))),
    };
  };

  // Stored links between two entities (none today; the reflector may add some).
  for (const e of kg.edges) {
    if (isPerson(e.src) || isPerson(e.dst)) continue;
    for (const a of mentionsByRaw.get(e.src) ?? [])
      for (const b of mentionsByRaw.get(e.dst) ?? []) add(idOf.get(a)!, idOf.get(b)!, 'stored', e.weight);
  }

  // Role and company named in one label.
  for (const p of pairs) add(idOf.get(p.a)!, idOf.get(p.b)!, p.kind, p.weight);

  const ms = (pred: (m: Mention) => boolean) => mentions.filter(pred);
  const sameSource = (a: Mention, b: Mention) =>
    a.url ? a.url === b.url : !b.url && a.source === 'search' && b.source === 'search';
  const roles = ms((m) => m.ns === 'role');
  const currentRoles = roles.filter((m) => m.current);
  const currentOrgs = ms((m) => m.ns === 'org' && m.current);
  const places = ms((m) => m.ns === 'place');

  // The current job title and the current employer, from one profile.
  for (const r of currentRoles)
    for (const o of currentOrgs)
      if (sameSource(r, o)) add(idOf.get(r)!, idOf.get(o)!, 'holds', 0.95 * Math.min(r.conf, o.conf));

  // Related roles: one's words contain the other's ("Senior Software Engineer" and "Software Engineer").
  const roleNodes = nodes.filter((n) => n.kind === 'Role');
  for (let i = 0; i < roleNodes.length; i++)
    for (let j = i + 1; j < roleNodes.length; j++) {
      const a = tokens(roleNodes[i]!.label);
      const b = tokens(roleNodes[j]!.label);
      const shared = [...a].filter((w) => b.has(w)).length;
      const contained = shared === Math.min(a.size, b.size) && shared > 0;
      if (contained || shared / (a.size + b.size - shared) >= 0.5)
        add(
          roleNodes[i]!.id,
          roleNodes[j]!.id,
          'related-role',
          0.8 * Math.min(roleNodes[i]!.confidence, roleNodes[j]!.confidence),
        );
    }

  // Profile skills go with the current role on the same profile; at most six per role, the rest link through lists.
  const uses: MapEdge[] = [];
  const byConf = [...currentRoles].sort((a, b) => b.conf - a.conf);
  for (const s of ms((m) => m.ns === 'topic' && m.kind === 'Skill' && m.source === 'search')) {
    // From another page of the same search (a portfolio next to a profile), the link is weaker.
    const same = byConf.find((x) => sameSource(x, s));
    const r = same ?? byConf[0];
    if (r)
      uses.push(cand(idOf.get(s)!, idOf.get(r)!, 'uses', (same ? 0.8 : 0.65) * Math.min(s.conf, r.conf)));
  }
  const usesByRole = new Map<string, MapEdge[]>();
  for (const e of uses) {
    const role = nodeById.get(e.source)?.kind === 'Role' ? e.source : e.target;
    usesByRole.set(role, [...(usesByRole.get(role) ?? []), e]);
  }
  // Each list's first items before any list's later ones, so every list reaches the role.
  const position = (e: MapEdge) => {
    const skill = nodeById.get(e.source)?.kind === 'Role' ? e.target : e.source;
    return Math.min(...mentions.filter((m) => idOf.get(m) === skill).map((m) => m.group?.index ?? 0));
  };
  for (const list of usesByRole.values())
    addAll(
      [...list]
        .sort((a, b) => b.weight - a.weight || position(a) - position(b) || a.id.localeCompare(b.id))
        .slice(0, 6),
    );

  // Items of one list (a split label, or one profile's schools or past employers), as a chain, closed into a ring
  // past three.
  const groups = new Map<string, Mention[]>();
  for (const m of mentions) if (m.group) groups.set(m.group.id, [...(groups.get(m.group.id) ?? []), m]);
  for (const g of groups.values()) {
    const ids = [...new Set(g.sort((a, b) => a.group!.index - b.group!.index).map((m) => idOf.get(m)!))];
    for (let i = 0; i < ids.length - 1; i++) add(ids[i]!, ids[i + 1]!, 'listed-with', 0.9 * conf(ids[i]!));
    if (ids.length > 3) add(ids.at(-1)!, ids[0]!, 'listed-with', 0.9 * conf(ids[0]!));
  }

  // The current employer and the home location, from one profile.
  for (const o of currentOrgs)
    for (const p of places)
      if (sameSource(o, p)) add(idOf.get(o)!, idOf.get(p)!, 'based-in', 0.75 * Math.min(o.conf, p.conf));

  // A company or school named after a place: the city, or more weakly its region.
  const orgNodes = nodes.filter((n) => n.kind === 'Company' || n.kind === 'School');
  for (const p of nodes.filter((n) => n.kind === 'Place')) {
    const [city, ...regions] = placeParts(p.label).map(normKey);
    for (const o of orgNodes) {
      const name = ` ${normKey(o.label)} `;
      const w = Math.min(o.confidence, p.confidence);
      if (city && name.includes(` ${city} `)) add(o.id, p.id, 'located-in', 0.9 * w);
      else if (regions.some((r) => r.length >= 4 && name.includes(` ${r} `)))
        add(o.id, p.id, 'located-in', 0.65 * w);
    }
  }

  // Answers: an entity the person told us about and a trait, or two entities, citing the same answers.
  const traits = nodes.filter((n) => n.category === 'trait');
  const told = nodes.filter((n) => n.category !== 'trait' && n.evidence.length);
  const traitLinks: MapEdge[] = [];
  for (const e of told)
    for (const t of traits) {
      const n = overlap(e.evidence, t.evidence);
      if (n)
        traitLinks.push(
          cand(
            e.id,
            t.id,
            'evidence',
            Math.min(e.confidence, t.confidence) * (0.85 + (0.15 * n) / e.evidence.length),
          ),
        );
    }
  addAll(capPerNode(traitLinks, 4));
  const toldLinks: MapEdge[] = [];
  for (let i = 0; i < told.length; i++)
    for (let j = i + 1; j < told.length; j++) {
      const jac = jaccard(told[i]!.evidence, told[j]!.evidence);
      if (jac >= 0.25) toldLinks.push(cand(told[i]!.id, told[j]!.id, 'shared-evidence', 0.7 + 0.3 * jac));
    }
  addAll(capPerNode(toldLinks, 3));

  // Traits one insight names together, and traits whose insights cite the same answers.
  const traitMentions = ms((m) => m.ns === 'trait');
  const byInsight = new Map<string, Array<{ id: string; conf: number }>>();
  for (const m of traitMentions)
    for (const i of m.insights)
      if (i.id) byInsight.set(i.id, [...(byInsight.get(i.id) ?? []), { id: idOf.get(m)!, conf: i.conf }]);
  for (const cited of byInsight.values())
    for (let i = 0; i < cited.length; i++)
      for (let j = i + 1; j < cited.length; j++)
        add(cited[i]!.id, cited[j]!.id, 'co-insight', cited[i]!.conf);
  const insightEvidence = traitMentions.map((m) => ({
    id: idOf.get(m)!,
    ev: [...new Set(m.insights.flatMap((i) => i.evidence))],
  }));
  const traitPairs: MapEdge[] = [];
  for (let i = 0; i < insightEvidence.length; i++)
    for (let j = i + 1; j < insightEvidence.length; j++) {
      const a = insightEvidence[i]!;
      const b = insightEvidence[j]!;
      const jac = jaccard(a.ev, b.ev);
      if (jac >= 0.34) traitPairs.push(cand(a.id, b.id, 'shared-evidence', 0.6 + 0.4 * jac));
    }
  addAll(capPerNode(traitPairs, 3));

  // A role says where it was held, from the links just made.
  const all = [...edges.values()];
  for (const n of nodes) {
    if (n.kind !== 'Role') continue;
    const orgs = all
      .filter((e) => (e.kind === 'role-at' || e.kind === 'holds') && (e.source === n.id || e.target === n.id))
      .map((e) => nodeById.get(e.source === n.id ? e.target : e.source)!.label)
      .sort();
    const what = current.has(n.id) ? 'Current role' : 'Role';
    n.description = orgs.length ? `${what} at ${listText(orgs)}` : what;
  }

  return {
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** The confidence the map opens at, and the slider's range. */
export const DEFAULT_THRESHOLD = 0.5;
export const THRESHOLD_RANGE = { min: 0.3, max: 0.9, step: 0.05 } as const;

/** Most links any one node may keep: a hub pulls everything into a star, which is what this map replaces. */
export function maxDegree(nodeCount: number): number {
  return Math.max(4, Math.floor(0.3 * (nodeCount - 1)));
}

export interface GraphView extends MapGraph {
  degree: Map<string, number>;
  /** Nodes above the threshold with no link there, left out of the map. */
  unlinked: number;
}

/**
 * What the map shows: nodes and edges at or above `threshold` in the visible categories, a hub guard, and no
 * isolated nodes (a node with no link at this threshold has nothing to say about the rest).
 */
export function filterGraph(
  g: MapGraph,
  opts: { threshold: number; hidden?: ReadonlySet<Category> },
): GraphView {
  const hidden = opts.hidden ?? new Set<Category>();
  const keep = new Map(
    g.nodes.filter((n) => n.confidence >= opts.threshold && !hidden.has(n.category)).map((n) => [n.id, n]),
  );
  let edges = g.edges.filter((e) => e.weight >= opts.threshold && keep.has(e.source) && keep.has(e.target));
  const degree = new Map<string, number>();
  const count = (es: MapEdge[]) => {
    degree.clear();
    for (const e of es) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
  };
  count(edges);
  const linked = [...keep.keys()].filter((id) => degree.has(id)).length;
  const cap = maxDegree(linked);
  // Drop a hub's weakest links first, never one that is the other end's only link.
  for (const e of [...edges].sort((a, b) => a.weight - b.weight || a.id.localeCompare(b.id))) {
    const s = degree.get(e.source)!;
    const t = degree.get(e.target)!;
    if ((s > cap && t > 1) || (t > cap && s > 1)) {
      edges = edges.filter((x) => x !== e);
      degree.set(e.source, s - 1);
      degree.set(e.target, t - 1);
    }
  }
  count(edges);
  const nodes = [...keep.values()].filter((n) => degree.has(n.id));
  return { nodes, edges, degree, unlinked: keep.size - nodes.length };
}

/** Label and size priority: well-linked, confident nodes first. */
export function importance(n: MapNode, degree: number): number {
  return n.confidence * (1 + Math.log2(1 + degree));
}

/**
 * Nodes in label order: the top two of each category first, so every cluster is named, then by importance.
 */
export function labelOrder(view: GraphView): MapNode[] {
  const score = (n: MapNode) => importance(n, view.degree.get(n.id) ?? 0);
  const sorted = [...view.nodes].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const leads: MapNode[] = [];
  for (const rank of [0, 1])
    for (const c of CATEGORIES) {
      const n = sorted.filter((x) => x.category === c.id)[rank];
      if (n) leads.push(n);
    }
  return [...leads, ...sorted.filter((n) => !leads.includes(n))];
}

/** Tidies a label for search matching. */
export const searchKey = (s: string) => normKey(tidy(s));
