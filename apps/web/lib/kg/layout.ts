import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Category } from './build';

/**
 * The map's layout (ADR-0046): a force layout with soft clusters. Each category pulls its nodes toward an anchor on
 * a ring; nodes linked across categories are pulled less, so they settle between clusters as bridges. Nodes and the
 * labels shown at default zoom are boxes that may not overlap. It runs to completion synchronously from a seeded
 * start, so the same graph at the same size always lays out the same way, and nothing moves once it is drawn.
 */

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
  category: Category;
  r: number;
  /** A label box reserved under the node (for the labels shown at default zoom). */
  label?: { w: number; h: number };
}

export interface LayoutEdge {
  source: string;
  target: string;
  weight: number;
}

export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  /** Every category in the whole graph, so hiding one doesn't move the others' anchors. */
  categories: Category[];
  /** Areas to keep clear, such as controls drawn over the canvas. */
  avoid?: Box[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Anchor order around the ring: neighbors are the categories most often linked. */
const RING: Category[] = ['work', 'skill', 'interest', 'trait', 'place'];

/** Keeps boxes this far from each other and from the edges of the canvas. */
const GAP = 3;
const TICKS = 320;

export function anchorsFor(categories: Category[], width: number, height: number): Map<Category, Point> {
  const present = RING.filter((c) => categories.includes(c));
  const cx = width / 2;
  const cy = height / 2;
  const out = new Map<Category, Point>();
  present.forEach((c, i) => {
    if (present.length === 1) {
      out.set(c, { x: cx, y: cy });
      return;
    }
    // Start on the left and go clockwise (y points down).
    const a = Math.PI + (2 * Math.PI * i) / present.length;
    out.set(c, { x: cx + width * 0.32 * Math.cos(a), y: cy + height * 0.32 * Math.sin(a) });
  });
  return out;
}

/** FNV-1a: a stable hash for seeding positions. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface SimNode extends SimulationNodeDatum, LayoutNode {
  ax: number;
  ay: number;
  pull: number;
}

type SimLink = SimulationLinkDatum<SimNode> & { weight: number; same: boolean };

/** Extents of a node's box around its center: its circle, plus the reserved label below it. */
function extents(n: LayoutNode) {
  const half = Math.max(n.r, (n.label?.w ?? 0) / 2);
  return { l: half, r: half, t: n.r, b: n.r + (n.label ? 2 + n.label.h : 0) };
}

/** Pushes overlapping boxes apart along their shorter overlap; `k` is how much of the overlap to fix per pass. */
function separate(nodes: SimNode[], k: number): number {
  let worst = 0;
  const ext = nodes.map(extents);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const ea = ext[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      const eb = ext[j]!;
      const ox = Math.min(a.x! + ea.r, b.x! + eb.r) - Math.max(a.x! - ea.l, b.x! - eb.l) + GAP;
      const oy = Math.min(a.y! + ea.b, b.y! + eb.b) - Math.max(a.y! - ea.t, b.y! - eb.t) + GAP;
      if (ox <= 0 || oy <= 0) continue;
      worst = Math.max(worst, Math.min(ox, oy));
      if (ox < oy) {
        const d = ((a.x! < b.x! || (a.x === b.x && i < j) ? -1 : 1) * ox * k) / 2;
        a.x! += d;
        b.x! -= d;
      } else {
        const d = ((a.y! < b.y! || (a.y === b.y && i < j) ? -1 : 1) * oy * k) / 2;
        a.y! += d;
        b.y! -= d;
      }
    }
  }
  return worst;
}

/** Keeps every box inside the canvas and out of the areas to avoid. */
function clamp(nodes: SimNode[], width: number, height: number, avoid: Box[]) {
  for (const n of nodes) {
    const e = extents(n);
    for (const b of avoid) {
      const left = n.x! + e.r + GAP - b.x;
      const right = b.x + b.w + GAP - (n.x! - e.l);
      const up = n.y! + e.b + GAP - b.y;
      const down = b.y + b.h + GAP - (n.y! - e.t);
      if (left <= 0 || right <= 0 || up <= 0 || down <= 0) continue;
      // The shortest way out that stays on the canvas: an area in a corner has two ways out that would leave it, and
      // the canvas clamp would put the box straight back.
      const ways = [
        { d: left, fits: n.x! - left - e.l >= GAP, move: () => (n.x! -= left) },
        { d: right, fits: n.x! + right + e.r <= width - GAP, move: () => (n.x! += right) },
        { d: up, fits: n.y! - up - e.t >= GAP, move: () => (n.y! -= up) },
        { d: down, fits: n.y! + down + e.b <= height - GAP, move: () => (n.y! += down) },
      ];
      const open = ways.filter((w) => w.fits);
      (open.length ? open : ways).reduce((a, w) => (w.d < a.d ? w : a)).move();
    }
    n.x = Math.max(e.l + GAP, Math.min(width - e.r - GAP, n.x!));
    n.y = Math.max(e.t + GAP, Math.min(height - e.b - GAP, n.y!));
  }
}

/** Stretches the settled layout to fill the canvas (up to 1.4×), keeping its shape. */
function fill(nodes: SimNode[], width: number, height: number) {
  if (nodes.length < 2) return;
  const ext = nodes.map(extents);
  const x0 = Math.min(...nodes.map((n, i) => n.x! - ext[i]!.l));
  const x1 = Math.max(...nodes.map((n, i) => n.x! + ext[i]!.r));
  const y0 = Math.min(...nodes.map((n, i) => n.y! - ext[i]!.t));
  const y1 = Math.max(...nodes.map((n, i) => n.y! + ext[i]!.b));
  const m = 2 * GAP;
  const sx = Math.min(1.4, (width - m) / Math.max(1, x1 - x0));
  const sy = Math.min(1.4, (height - m) / Math.max(1, y1 - y0));
  if (sx <= 1 && sy <= 1) return;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  for (const n of nodes) {
    n.x = width / 2 + (n.x! - cx) * Math.max(1, sx);
    n.y = height / 2 + (n.y! - cy) * Math.max(1, sy);
  }
}

export function layoutGraph(input: LayoutInput): Map<string, Point> {
  const { width, height } = input;
  const avoid = input.avoid ?? [];
  const anchors = anchorsFor(input.categories, width, height);
  const center = { x: width / 2, y: height / 2 };
  const sorted = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((n) => [n.id, n]));
  const degree = new Map<string, number>();
  const cross = new Map<string, number>();
  const edges = input.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  for (const e of edges) {
    const same = byId.get(e.source)!.category === byId.get(e.target)!.category;
    for (const id of [e.source, e.target]) {
      degree.set(id, (degree.get(id) ?? 0) + 1);
      if (!same) cross.set(id, (cross.get(id) ?? 0) + 1);
    }
  }
  const spread = Math.min(width, height) * 0.12;
  const nodes: SimNode[] = sorted.map((n) => {
    const a = anchors.get(n.category) ?? center;
    const h = hash(n.id);
    const angle = ((h & 0xffff) / 0x10000) * 2 * Math.PI;
    const dist = spread * (0.3 + 0.7 * ((h >>> 16) / 0x10000));
    const bridge = (cross.get(n.id) ?? 0) / Math.max(1, degree.get(n.id) ?? 0);
    return {
      ...n,
      x: a.x + dist * Math.cos(angle),
      y: a.y + dist * Math.sin(angle),
      ax: a.x,
      ay: a.y,
      pull: 0.12 * (1 - 0.45 * bridge),
    };
  });
  const links: SimLink[] = edges
    .map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
      same: byId.get(e.source)!.category === byId.get(e.target)!.category,
    }))
    .sort((a, b) => `${a.source}|${a.target}`.localeCompare(`${b.source}|${b.target}`));
  const scale = Math.sqrt((width * height) / Math.max(12, nodes.length)) / 60;
  const sim = forceSimulation<SimNode>(nodes)
    .randomSource(lcg(0x5eed))
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((l) => (l.same ? 30 : 64) * scale)
        .strength(
          (l) =>
            ((l.same ? 1 : 0.6) * (0.15 + 0.5 * l.weight)) /
            Math.min(degree.get((l.source as SimNode).id) ?? 1, degree.get((l.target as SimNode).id) ?? 1),
        ),
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength((d) => -(24 + 5 * d.r) * scale)
        // Local repulsion only: separate groups of one category stay together instead of drifting to the edges.
        .distanceMax(Math.min(width, height) * 0.28),
    )
    .force(
      'x',
      forceX<SimNode>((d) => d.ax).strength((d) => d.pull),
    )
    .force(
      'y',
      forceY<SimNode>((d) => d.ay).strength((d) => d.pull),
    )
    .stop();
  for (let i = 0; i < TICKS; i++) {
    sim.tick();
    // Collisions stiffen as the layout cools, so early ticks can still rearrange.
    separate(nodes, 0.2 + 0.6 * (i / TICKS));
    clamp(nodes, width, height, avoid);
  }
  fill(nodes, width, height);
  for (let i = 0; i < 200; i++) {
    const worst = separate(nodes, 1);
    clamp(nodes, width, height, avoid);
    if (worst <= 0.01) break;
  }
  return new Map(nodes.map((n) => [n.id, { x: n.x!, y: n.y! }]));
}
