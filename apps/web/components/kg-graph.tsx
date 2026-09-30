'use client';
import type { UiSnapshot } from '@mimic/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const COLORS: Record<string, string> = {
  Person: '#262a31',
  Organization: '#2d4fb3',
  Place: '#4a7f62',
  Occupation: '#2d4fb3',
  Skill: '#66707d',
  Interest: '#a9543a',
  Facet: '#8a93a0',
};

interface N {
  id: string;
  label: string;
  type: string;
  x?: number;
  y?: number;
}

/** Mini knowledge graph (PLAN §10.1): canvas force layout, at most 60 nodes. */
export function KgGraph({ kg }: { kg: UiSnapshot['kg'] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
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
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (kg.nodes.length <= 1) {
    return (
      <p className="text-[13px] text-muted">
        Places, organizations and interests you confirm will appear here.
      </p>
    );
  }
  return (
    <div
      ref={wrap}
      className="overflow-hidden rounded-[10px] border border-line bg-raised"
      role="img"
      aria-label={`Map of ${kg.nodes.length - 1} things connected to you: ${kg.nodes
        .filter((n) => n.type !== 'Person')
        .map((n) => n.label)
        .join(', ')}`}
    >
      <ForceGraph2D<N>
        graphData={data}
        width={width}
        height={220}
        backgroundColor="#ffffff"
        cooldownTicks={reduced ? 0 : 80}
        enableZoomInteraction={false}
        linkColor={() => '#d9dee5'}
        nodeRelSize={4}
        nodeCanvasObject={(node, ctx, scale) => {
          const r = node.type === 'Person' ? 6 : 4;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
          ctx.fillStyle = COLORS[node.type] ?? '#66707d';
          ctx.fill();
          const fontSize = 11 / scale;
          ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = '#454b55';
          ctx.textAlign = 'center';
          ctx.fillText(node.label.slice(0, 24), node.x ?? 0, (node.y ?? 0) + r + fontSize + 1);
        }}
      />
    </div>
  );
}
