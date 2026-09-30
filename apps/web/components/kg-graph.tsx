'use client';
import type { UiSnapshot } from '@mimic/core';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildGraph,
  CATEGORIES,
  type Category,
  DEFAULT_THRESHOLD,
  EDGE_PHRASE,
  filterGraph,
  type GraphView,
  labelOrder,
  type MapNode,
  searchKey,
  THRESHOLD_RANGE,
} from '@/lib/kg/build';
import { truncate } from '@/lib/kg/clean';
import { type PlacedLabel, placeLabels } from '@/lib/kg/labels';
import { hash, layoutGraph, type Point } from '@/lib/kg/layout';
import { cn } from './ui';

/**
 * "Your map" (ADR-0046): the knowledge graph as a network of the things in a person's life, clustered by category.
 * The data builder, layout and label placement live in `lib/kg`; this renders them as SVG and handles hover, focus,
 * zoom, pan, drag, search, category toggles and the confidence threshold.
 */

const COLOR: Record<Category, string> = {
  work: 'var(--kg-work)',
  place: 'var(--kg-place)',
  interest: 'var(--kg-interest)',
  skill: 'var(--kg-skill)',
  trait: 'var(--kg-trait)',
};
const FONT_FAMILY =
  '"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT = `11px ${FONT_FAMILY}`;
const LABEL_H = 14;
const LABEL_CHARS = 24;
const K_MIN = 0.6;
const K_MAX = 4;

interface Transform {
  x: number;
  y: number;
  k: number;
}
const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

/** Taller than wide on phones, so five clusters fit side by side and stacked. */
export const mapHeight = (width: number) => Math.round(Math.min(500, Math.max(400, width * 0.4 + 260)));

/** Wide maps show a focused node's details beside the map, phones under it; this is where. */
const isWide = (width: number) => width >= 560;
const DOCK_W = 276;
const DOCK_H = 180;

/** The zoom controls' corner, kept clear of nodes and labels. */
const controlsBox = (width: number) => ({ x: width - 48, y: 0, w: 48, h: 112 });

/** Labels shown at default zoom; more appear as the map zooms in. */
const labelBudget = (width: number, k: number) => Math.round((width < 480 ? 12 : 18) * k * k);

const radiusOf = (n: MapNode, degree: number) =>
  Math.min(9, 2 + 1.2 * Math.sqrt(degree) + 2.2 * n.confidence);

const pct = (x: number) => `${Math.round(x * 100)}%`;
const clampK = (k: number) => Math.max(K_MIN, Math.min(K_MAX, k));

/** A callback ref: the measured element mounts only once the graph has nodes, which can be after the first render. */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

/** Text width in the label font at a weight, re-measured once web fonts load. */
function useMeasure() {
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new function when fonts load, so labels are measured again
  return useMemo(() => {
    const cache = new Map<string, number>();
    const ctx = document.createElement('canvas').getContext('2d');
    return (text: string, weight = 400) => {
      const key = `${weight}|${text}`;
      let w = cache.get(key);
      if (w === undefined) {
        if (ctx) ctx.font = `${weight} ${FONT}`;
        w = Math.ceil(ctx ? ctx.measureText(text).width : text.length * 6) + 2;
        cache.set(key, w);
      }
      return w;
    };
  }, [fontsReady]);
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Positions eased from the previous layout to the new one, so a threshold or category change doesn't jump. */
function useTweened(target: Map<string, Point>, reduced: boolean) {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const from = shownRef.current;
    if (reduced || from === target) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const e = ease(Math.min(1, (now - start) / 420));
      const next = new Map<string, Point>();
      for (const [id, p] of target) {
        const f = from.get(id) ?? p;
        next.set(id, { x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e });
      }
      shownRef.current = next;
      setShown(next);
      if (e < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return shown;
}

type Gesture =
  | { mode: 'pan' | 'tap'; id: number; sx: number; sy: number; t0: Transform; moved: boolean }
  | { mode: 'node'; id: number; node: string; sx: number; sy: number; moved: boolean }
  | { mode: 'pinch'; d0: number; mid0: Point; t0: Transform };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function KgGraph({ kg, facets }: { kg: UiSnapshot['kg']; facets?: UiSnapshot['facets'] }) {
  const graph = useMemo(() => buildGraph(kg, facets), [kg, facets]);
  const { ref: wrapRef, width } = useWidth();
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [hidden, setHidden] = useState<ReadonlySet<Category>>(new Set());
  const [query, setQuery] = useState('');
  const view = useMemo(() => filterGraph(graph, { threshold, hidden }), [graph, threshold, hidden]);
  const categories = useMemo(() => [...new Set(graph.nodes.map((n) => n.category))], [graph]);
  const matches = useMemo(() => {
    const q = searchKey(query);
    if (!q) return null;
    return new Set(view.nodes.filter((n) => searchKey(n.label).includes(q)).map((n) => n.id));
  }, [query, view]);
  // Enter in the search box focuses the best match; each press is a new request.
  const [jump, setJump] = useState(0);
  const searchId = useId();

  if (!graph.nodes.length) {
    return (
      <p className="text-[13px] text-muted">
        Places, organizations and interests you confirm will appear here.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <SearchBox
        id={searchId}
        value={query}
        found={matches?.size ?? null}
        onChange={setQuery}
        onSubmit={() => setJump((j) => j + 1)}
      />
      <div ref={wrapRef} className="overflow-hidden rounded-[10px] border border-line bg-raised">
        {width > 0 && (
          <Canvas
            view={view}
            width={width}
            categories={categories}
            matches={matches}
            jump={jump}
            onClearQuery={() => setQuery('')}
          />
        )}
        <div className="space-y-2 border-t border-line px-3 py-2">
          <fieldset className="flex flex-wrap gap-1">
            <legend className="sr-only">Show categories</legend>
            {CATEGORIES.filter((c) => categories.includes(c.id)).map((c) => {
              const on = !hidden.has(c.id);
              const count = view.nodes.filter((n) => n.category === c.id).length;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (on) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                  className={cn(
                    'inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors motion-reduce:transition-none',
                    'hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink',
                    on ? 'text-graphite-soft' : 'text-muted line-through',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 rounded-full border-2"
                    style={{ borderColor: COLOR[c.id], background: on ? COLOR[c.id] : 'transparent' }}
                  />
                  {c.label}
                  {on && <span className="tabular text-muted">{count}</span>}
                </button>
              );
            })}
          </fieldset>
          <label className="flex items-center gap-3 text-[12px] text-muted">
            <span className="shrink-0">Confidence</span>
            <input
              type="range"
              min={THRESHOLD_RANGE.min}
              max={THRESHOLD_RANGE.max}
              step={THRESHOLD_RANGE.step}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="h-8 min-w-0 flex-1 accent-[var(--ink)]"
              aria-valuetext={`At least ${pct(threshold)}`}
            />
            <span className="w-9 shrink-0 text-right tabular">{pct(threshold)}+</span>
          </label>
        </div>
      </div>
      <p className="text-[12px] text-muted">
        <span className="tabular">
          Showing {view.nodes.length} of {graph.nodes.length}.
        </span>{' '}
        Hover or tap a dot for details; click one to focus its links. Drag to pan, pinch or Ctrl-scroll to
        zoom.
      </p>
      <MapList view={view} />
    </div>
  );
}

function SearchBox({
  id,
  value,
  found,
  onChange,
  onSubmit,
}: {
  id: string;
  value: string;
  found: number | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Find in your map
      </label>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
      >
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Find in your map"
        autoComplete="off"
        className="h-10 w-full rounded-[10px] border border-line bg-raised pr-24 pl-9 text-[14px] text-graphite placeholder:text-muted focus-visible:border-ink focus-visible:outline-none"
      />
      <span
        aria-live="polite"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-muted tabular"
      >
        {found === null ? '' : found ? `${found} found` : 'None found'}
      </span>
    </form>
  );
}

function Canvas({
  view,
  width,
  categories,
  matches,
  jump,
  onClearQuery,
}: {
  view: GraphView;
  width: number;
  categories: Category[];
  /** Search matches, or null when there's no search. */
  matches: ReadonlySet<string> | null;
  /** Bumped when the person presses Enter in the search box. */
  jump: number;
  onClearQuery: () => void;
}) {
  const height = mapHeight(width);
  const measure = useMeasure();
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const byId = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view]);
  const neighbors = useMemo(() => {
    const m = new Map<
      string,
      Array<{ id: string; kind: GraphView['edges'][number]['kind']; weight: number }>
    >();
    for (const e of view.edges) {
      m.set(e.source, [...(m.get(e.source) ?? []), { id: e.target, kind: e.kind, weight: e.weight }]);
      m.set(e.target, [...(m.get(e.target) ?? []), { id: e.source, kind: e.kind, weight: e.weight }]);
    }
    return m;
  }, [view]);
  const radius = useCallback((n: MapNode) => radiusOf(n, view.degree.get(n.id) ?? 0), [view]);
  const order = useMemo(() => labelOrder(view), [view]);

  // Layout: labels shown at default zoom reserve their space, so they fit without overlaps.
  const target = useMemo(() => {
    const labeled = new Set(order.slice(0, labelBudget(width, 1)).map((n) => n.id));
    return layoutGraph({
      width,
      height,
      categories,
      nodes: view.nodes.map((n) => ({
        id: n.id,
        category: n.category,
        r: radius(n),
        ...(labeled.has(n.id) ? { label: { w: measure(truncate(n.short, LABEL_CHARS)), h: LABEL_H } } : {}),
      })),
      edges: view.edges,
      avoid: [controlsBox(width)],
    });
  }, [view, order, width, height, categories, radius, measure]);
  const laid = useTweened(target, reduced);
  const [pins, setPins] = useState<Map<string, Point>>(new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout drops dragged positions
  useEffect(() => setPins(new Map()), [target]);
  // A node new to this layout isn't in the eased positions until the next frame: it starts where it settles.
  const pos = useCallback(
    (id: string) => pins.get(id) ?? laid.get(id) ?? target.get(id) ?? { x: 0, y: 0 },
    [pins, laid, target],
  );

  // View transform, with eased transitions for focus and reset.
  const [t, setTState] = useState<Transform>(IDENTITY);
  const tRef = useRef(t);
  const anim = useRef(0);
  const setT = useCallback((next: Transform) => {
    cancelAnimationFrame(anim.current);
    tRef.current = next;
    setTState(next);
  }, []);
  const animateTo = useCallback(
    (to: Transform) => {
      cancelAnimationFrame(anim.current);
      const from = tRef.current;
      if (reduced) {
        tRef.current = to;
        setTState(to);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const e = ease(Math.min(1, (now - start) / 380));
        const next = {
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
          k: from.k + (to.k - from.k) * e,
        };
        tRef.current = next;
        setTState(next);
        if (e < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [reduced],
  );
  const zoomAt = useCallback(
    (p: Point, factor: number) => {
      const cur = tRef.current;
      const k = clampK(cur.k * factor);
      setT({ x: p.x - ((p.x - cur.x) / cur.k) * k, y: p.y - ((p.y - cur.y) / cur.k) * k, k });
    },
    [setT],
  );

  const [hoverState, setHover] = useState<string | null>(null);
  const [focusState, setFocus] = useState<string | null>(null);
  // A node hidden by the threshold or a category toggle can't stay hovered or focused.
  const hover = hoverState && byId.has(hoverState) ? hoverState : null;
  const focus = focusState && byId.has(focusState) ? focusState : null;
  useEffect(() => {
    if (focusState && !focus) setFocus(null);
    if (hoverState && !hover) setHover(null);
  }, [focusState, focus, hoverState, hover]);

  const focusOn = useCallback(
    (id: string | null) => {
      setFocus(id);
      if (!id) {
        animateTo(IDENTITY);
        return;
      }
      const pts = [id, ...(neighbors.get(id) ?? []).map((n) => n.id)].map(pos);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      // Frame the neighborhood in the part of the map the docked details leave free.
      const area = isWide(width)
        ? { x: DOCK_W, y: 0, w: width - DOCK_W - 40, h: height }
        : { x: 0, y: 0, w: width, h: height - DOCK_H };
      const fit = Math.min(area.w / (x1 - x0 + 140), area.h / (y1 - y0 + 60));
      const k = Math.max(0.7, Math.min(2.5, fit));
      animateTo({
        x: area.x + area.w / 2 - ((x0 + x1) / 2) * k,
        y: area.y + area.h / 2 - ((y0 + y1) / 2) * k,
        k,
      });
    },
    [animateTo, neighbors, pos, width, height],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per Enter press, with the matches as they are then
  useEffect(() => {
    const best = order.find((n) => matches?.has(n.id));
    if (jump && best) focusOn(best.id);
  }, [jump]);

  const active = hover ?? focus;
  const lit = useMemo(() => {
    if (active) return new Set([active, ...(neighbors.get(active) ?? []).map((n) => n.id)]);
    // A search that finds nothing says so in the box; it doesn't dim the whole map and hide every label.
    return matches?.size ? matches : null;
  }, [active, neighbors, matches]);

  // Gestures: drag the background to pan (mouse and pen; touch scrolls the page), drag a dot to move it, tap or
  // click a dot to focus, pinch or Ctrl-scroll to zoom.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const local = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    // Focus from a pointer shows no ring; the keys bring it back.
    e.currentTarget.dataset.pointer = '';
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      gesture.current = { mode: 'pinch', d0: dist(a, b), mid0: mid(a, b), t0: tRef.current };
      return;
    }
    const node = (e.target as Element).closest('[data-node]')?.getAttribute('data-node');
    if (node) gesture.current = { mode: 'node', id: e.pointerId, node, sx: p.x, sy: p.y, moved: false };
    else
      gesture.current = {
        mode: e.pointerType === 'touch' ? 'tap' : 'pan',
        id: e.pointerId,
        sx: p.x,
        sy: p.y,
        t0: tRef.current,
        moved: false,
      };
    if (gesture.current.mode !== 'tap') svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.mode === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const k = clampK((g.t0.k * dist(a, b)) / g.d0);
      const m = mid(a, b);
      const wx = (g.mid0.x - g.t0.x) / g.t0.k;
      const wy = (g.mid0.y - g.t0.y) / g.t0.k;
      setT({ x: m.x - wx * k, y: m.y - wy * k, k });
      return;
    }
    if (e.pointerId !== g.id) return;
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 4) return;
    g.moved = true;
    if (g.mode === 'pan') setT({ ...g.t0, x: g.t0.x + p.x - g.sx, y: g.t0.y + p.y - g.sy });
    else if (g.mode === 'node') {
      const cur = tRef.current;
      setPins((m) => new Map(m).set(g.node, { x: (p.x - cur.x) / cur.k, y: (p.y - cur.y) / cur.k }));
    }
  };
  const onPointerEnd = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.mode === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null;
      return;
    }
    if (g.id !== e.pointerId) return;
    gesture.current = null;
    if (e.type !== 'pointerup' || g.moved) return;
    if (g.mode === 'node') focusOn(focus === g.node ? null : g.node);
    else if (focus) focusOn(null);
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(local(e), Math.exp(-e.deltaY * 0.01));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, local]);
  const reset = () => {
    setFocus(null);
    setPins(new Map());
    animateTo(IDENTITY);
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const center = { x: width / 2, y: height / 2 };
    const pan = (dx: number, dy: number) =>
      setT({ ...tRef.current, x: tRef.current.x + dx, y: tRef.current.y + dy });
    const keys: Record<string, () => void> = {
      Escape: () => (focus ? focusOn(null) : matches ? onClearQuery() : reset()),
      '+': () => zoomAt(center, 1.4),
      '=': () => zoomAt(center, 1.4),
      '-': () => zoomAt(center, 1 / 1.4),
      '0': reset,
      ArrowLeft: () => pan(40, 0),
      ArrowRight: () => pan(-40, 0),
      ArrowUp: () => pan(0, 40),
      ArrowDown: () => pan(0, -40),
    };
    delete e.currentTarget.dataset.pointer;
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };

  const screen = useCallback(
    (id: string) => {
      const p = pos(id);
      return { x: p.x * t.k + t.x, y: p.y * t.k + t.y };
    },
    [pos, t],
  );
  const scaleR = Math.min(1.6, Math.sqrt(t.k));

  // Labels: the active node's neighborhood, or search matches, or the top nodes, whichever fit.
  // A focused node's details dock (see Tooltip); labels under them would be hidden.
  const docked = !!focus && !hover;
  const labels: PlacedLabel[] = useMemo(() => {
    const dock = isWide(width)
      ? { x: 0, y: 0, w: DOCK_W, h: 220 }
      : { x: 0, y: height - DOCK_H, w: width, h: DOCK_H };
    const ranked = lit ? order.filter((n) => lit.has(n.id)) : order;
    const first = active ? [byId.get(active)!, ...ranked.filter((n) => n.id !== active)] : ranked;
    const drawn = view.nodes.map((n) => ({ id: n.id, ...screen(n.id), r: radius(n) * scaleR }));
    const at = new Map(drawn.map((d) => [d.id, d]));
    return placeLabels(
      first.map((n) => {
        const on = n.id === active;
        const text = truncate(on ? n.label : n.short, on ? 40 : LABEL_CHARS);
        // Measured at the weight it's drawn in: the active label is bold.
        return { ...at.get(n.id)!, text, w: measure(text, on ? 600 : 400), h: LABEL_H };
      }),
      drawn,
      { width, height },
      lit ? lit.size : labelBudget(width, t.k),
      [controlsBox(width), ...(docked ? [dock] : [])],
    );
  }, [lit, order, active, byId, view, screen, t.k, radius, scaleR, measure, width, height, docked]);

  const activeNode = active ? byId.get(active) : undefined;
  const summary = `Map of ${view.nodes.length} things from your profile and answers, in ${
    new Set(view.nodes.map((n) => n.category)).size
  } groups, with ${view.edges.length} links.`;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
        aria-keyshortcuts="Escape + - 0 ArrowLeft ArrowRight ArrowUp ArrowDown"
        // Focusable so the keys work after a click, and for keyboard users.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the map takes zoom, pan and Escape keys
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={(e) => delete e.currentTarget.dataset.pointer}
        className="block cursor-grab select-none focus-visible:rounded-[10px] focus-visible:-outline-offset-2 active:cursor-grabbing data-pointer:outline-none"
        style={{ touchAction: 'pan-x pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <g fill="none">
          {view.edges.map((e) => {
            const a = screen(e.source);
            const b = screen(e.target);
            const on = !!active && (e.source === active || e.target === active);
            const dim = !!lit && !on && !(lit.has(e.source) && lit.has(e.target) && !active);
            // A gentle curve, bowed to a side fixed per edge so it never flips.
            const side = hash(e.id) % 2 ? 1 : -1;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const cx = (a.x + b.x) / 2 - dy * 0.12 * side;
            const cy = (a.y + b.y) / 2 + dx * 0.12 * side;
            return (
              <path
                key={e.id}
                d={`M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`}
                stroke={on && activeNode ? COLOR[activeNode.category] : 'var(--slate)'}
                strokeOpacity={on ? 0.45 + 0.5 * e.weight : dim ? 0.04 : 0.08 + 0.32 * e.weight}
                strokeWidth={(on ? 0.8 : 0.5) + 1.3 * e.weight}
                strokeLinecap="round"
              />
            );
          })}
        </g>
        {view.nodes.map((n) => {
          const p = screen(n.id);
          const r = radius(n) * scaleR;
          const dim = !!lit && !lit.has(n.id);
          const ring = n.id === focus || (matches?.has(n.id) && !active);
          return (
            <g
              key={n.id}
              data-node={n.id}
              transform={`translate(${p.x},${p.y})`}
              opacity={dim ? 0.18 : 1}
              className="cursor-pointer"
              style={{ touchAction: 'none' }}
              onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(n.id)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && setHover((h) => (h === n.id ? null : h))}
            >
              <circle r={Math.max(12, r + 6)} fill="transparent" />
              {ring && <circle r={r + 3.5} fill="none" stroke={COLOR[n.category]} strokeWidth={1.5} />}
              <circle r={r} fill={COLOR[n.category]} stroke="var(--sheet)" strokeWidth={1.25} />
            </g>
          );
        })}
        <g
          fontSize={11}
          style={{ fontFamily: FONT_FAMILY }}
          stroke="var(--sheet)"
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke"
          pointerEvents="none"
        >
          {labels.map((l) => (
            <text
              key={l.id}
              x={l.x}
              y={l.y}
              textAnchor={l.anchor}
              dominantBaseline="central"
              fill={l.id === active ? 'var(--graphite)' : 'var(--graphite-soft)'}
              fontWeight={l.id === active ? 600 : 400}
            >
              {l.text}
            </text>
          ))}
        </g>
      </svg>
      <div className="absolute top-2 right-2 flex flex-col overflow-hidden rounded-[8px] border border-line bg-raised/90 shadow-[var(--shadow-card)]">
        <ZoomButton label="Zoom in" onClick={() => zoomAt({ x: width / 2, y: height / 2 }, 1.4)}>
          <path d="M10 5v10M5 10h10" />
        </ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => zoomAt({ x: width / 2, y: height / 2 }, 1 / 1.4)}>
          <path d="M5 10h10" />
        </ZoomButton>
        <ZoomButton label="Reset view" onClick={reset}>
          <path d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9M4.5 4.5v2.8h2.8" />
        </ZoomButton>
      </div>
      {activeNode && (
        <Tooltip
          node={activeNode}
          at={screen(activeNode.id)}
          r={radius(activeNode) * scaleR}
          label={labels.find((l) => l.id === activeNode.id)?.box}
          docked={docked}
          width={width}
          height={height}
          links={(neighbors.get(activeNode.id) ?? [])
            .map((l) => ({ ...l, node: byId.get(l.id)! }))
            .sort((a, b) => b.weight - a.weight)}
        />
      )}
      {!view.nodes.length && (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-muted">
          Nothing is linked at this confidence. Lower it or show more categories.
        </p>
      )}
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 items-center justify-center text-graphite-soft hover:bg-surface hover:text-graphite focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink [&+&]:border-t [&+&]:border-line"
    >
      <svg
        viewBox="0 0 20 20"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

function Tooltip({
  node,
  at,
  r,
  label,
  docked,
  width,
  height,
  links,
}: {
  node: MapNode;
  at: Point;
  r: number;
  /** The node's label box, which the tooltip must not cover. */
  label: { x: number; y: number; w: number; h: number } | undefined;
  /** A focused node's details sit in a fixed place, clear of the neighborhood framed beside them. */
  docked: boolean;
  width: number;
  height: number;
  links: Array<{ node: MapNode; kind: keyof typeof EDGE_PHRASE; weight: number }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const next = ref.current?.offsetHeight ?? 0;
    if (next !== h) setH(next);
  });
  const wide = isWide(width);
  const w = docked && !wide ? width - 16 : Math.min(260, width - 16);
  const gap = 12;
  // The node and its label, as one box to keep clear.
  const box = {
    x0: Math.min(at.x - r, label?.x ?? at.x),
    x1: Math.max(at.x + r, label ? label.x + label.w : at.x),
    y0: Math.min(at.y - r, label?.y ?? at.y),
    y1: Math.max(at.y + r, label ? label.y + label.h : at.y),
  };
  let left: number;
  let top: number;
  if (docked) {
    left = 8;
    top = wide ? 8 : height - h - 8;
  } else if (wide) {
    left = box.x1 + gap + w <= width - 8 ? box.x1 + gap : box.x0 - gap - w;
    top = at.y - h / 2;
  } else {
    left = at.x - w / 2;
    top = at.y < height * 0.5 && box.y1 + gap + h <= height - 8 ? box.y1 + gap : box.y0 - gap - h;
  }
  left = Math.max(8, Math.min(width - w - 8, left));
  top = Math.max(8, Math.min(height - h - 8, top));
  const seqs = node.evidence;
  const answers = seqs.length
    ? `your answer${seqs.length > 1 ? 's' : ''} ${seqs.slice(0, 5).join(', ')}${seqs.length > 5 ? ` +${seqs.length - 5}` : ''}`
    : null;
  const from = [
    ...node.sources.filter((s) => s !== 'Your answers'),
    ...(answers ? [answers] : node.sources.includes('Your answers') ? ['your answers'] : []),
  ];
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-10 rounded-[10px] border border-line bg-raised px-3 py-2 text-[12px] leading-snug shadow-[var(--shadow-pop)]"
      style={{ width: w, left, top, visibility: h ? 'visible' : 'hidden' }}
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-graphite">
        <span
          aria-hidden="true"
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ background: COLOR[node.category] }}
        />
        {node.label}
      </p>
      <p className="mt-0.5 text-muted">
        {node.kind} · {node.description}
      </p>
      {node.reading && <p className="mt-0.5 text-graphite-soft">Reading: {node.reading.toLowerCase()}</p>}
      <p className="mt-1 text-muted tabular">
        {from.length > 0 && <>From {from.join(' and ')} · </>}
        Confidence {pct(node.confidence)}
      </p>
      {links.length > 0 && (
        <p className="mt-1 text-graphite-soft">
          {links
            .slice(0, 4)
            .map((l) => `${truncate(l.node.short, 24)} (${EDGE_PHRASE[l.kind]})`)
            .join(', ')}
          {links.length > 4 ? `, +${links.length - 4} more` : ''}
        </p>
      )}
    </div>
  );
}

/** The map as a list, for screen readers. */
function MapList({ view }: { view: GraphView }) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const linked = (id: string) =>
    view.edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => byId.get(e.source === id ? e.target : e.source)!.label);
  return (
    <div className="sr-only">
      {CATEGORIES.map((c) => {
        const nodes = view.nodes.filter((n) => n.category === c.id);
        if (!nodes.length) return null;
        return (
          <section key={c.id} aria-label={c.label}>
            <ul>
              {nodes.map((n) => (
                <li key={n.id}>
                  {n.label}: {n.description}. Confidence {pct(n.confidence)}. Linked to{' '}
                  {linked(n.id).join(', ')}.
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
