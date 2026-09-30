'use client';
import type { UiSnapshot } from '@mimic/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

const COLORS: Record<string, string> = {
  Person: '#262a31',
  Organization: '#2d4fb3',
  Occupation: '#2d4fb3',
  Place: '#4a7f62',
  Skill: '#66707d',
  Interest: '#a9543a',
  Facet: '#aab2bd',
};

interface N {
  id: string;
  label: string;
  type: string;
  x?: number;
  y?: number;
}

/**
 * Mini knowledge graph (PLAN §10.1): canvas force layout, at most 60 nodes. Organizations, places, skills and
 * interests are labeled; facets are small dots labeled on hover so the map stays readable.
 */
export function KgGraph({ kg }: { kg: UiSnapshot['kg'] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraphMethods<N> | undefined>(undefined);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const data = useMemo(
    () => ({
      nodes: kg.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type })),
      links: kg.edges.map((e) => ({ source: e.src, target: e.dst })),
    }),
    [kg],
  );
  useEffect(() => {
    fg.current?.d3Force('charge')?.strength?.(-90);
    fg.current?.d3Force('link')?.distance?.(52);
  }, []);
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (kg.nodes.length <= 1) {
    return (
      <p className="text-[13px] text-muted">
        Places, organizations and interests you confirm will appear here.
      </p>
    );
  }
  const named = kg.nodes.filter((n) => n.type !== 'Person').map((n) => n.label);
  return (
    <div
      ref={wrap}
      className="overflow-hidden rounded-[10px] border border-line bg-raised"
      role="img"
      aria-label={`Map of ${named.length} things connected to you: ${named.join(', ')}`}
    >
      <ForceGraph2D<N>
        ref={fg}
        graphData={data}
        width={width}
        height={260}
        backgroundColor="#ffffff"
        cooldownTicks={reduced ? 0 : 90}
        onEngineStop={() => fg.current?.zoomToFit(250, 28)}
        enableZoomInteraction={false}
        linkColor={() => '#e3e7ec'}
        onNodeHover={(n) => setHover(n?.id ?? null)}
        nodeCanvasObject={(node, ctx, scale) => {
          const isFacet = node.type === 'Facet';
          const r = node.type === 'Person' ? 7 : isFacet ? 3 : 5;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
          ctx.fillStyle = COLORS[node.type] ?? '#66707d';
          ctx.fill();
          if (isFacet && hover !== node.id) return;
          const fontSize = (node.type === 'Person' ? 12 : 11) / scale;
          ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = isFacet ? '#66707d' : '#262a31';
          ctx.textAlign = 'center';
          ctx.fillText(node.label.slice(0, 26), node.x ?? 0, (node.y ?? 0) + r + fontSize + 1);
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, 8, 0, 2 * Math.PI);
          ctx.fill();
        }}
      />
      <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-muted">
        <Legend color={COLORS.Organization!} label="Work" />
        <Legend color={COLORS.Place!} label="Places" />
        <Legend color={COLORS.Interest!} label="Interests" />
        <Legend color={COLORS.Skill!} label="Skills" />
        <Legend color={COLORS.Facet!} label="Traits (hover)" />
      </p>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}
