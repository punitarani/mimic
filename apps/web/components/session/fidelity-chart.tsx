'use client';
import type { UiSnapshot } from '@mimic/core';
import { useEffect, useRef, useState } from 'react';

type Point = UiSnapshot['history'][number];

/**
 * How well it knows you over time (design: FidelityChart, option a): 104 px, y scaled to the data, the confidence
 * band, a dashed "profile alone" baseline, and labeled endpoints.
 */
export function FidelityChart({ points }: { points: Point[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(416);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (points.length < 2) return null;
  const H = 104;
  const L = 36;
  const R = W - 40;
  const T = 8;
  const B = H - 8;
  const v = points.map((p) => p.fidelity * 100);
  const lo = points.map((p) => p.ciLow * 100);
  const hi = points.map((p) => p.ciHigh * 100);
  const last = points.at(-1)!;
  // A guess from the profile alone, on the same scale as fidelity (accuracy ÷ self-consistency).
  const base =
    last.accBaseline !== null && last.selfConsistency > 0
      ? Math.min(100, (last.accBaseline / last.selfConsistency) * 100)
      : null;
  const all = [...lo, ...hi, ...(base === null ? [] : [base])];
  const yMin = Math.max(0, Math.floor(Math.min(...all) / 2) * 2 - 2);
  const yMax = Math.min(100, Math.ceil(Math.max(...all) / 2) * 2 + 2);
  const n = v.length;
  const x = (i: number) => +(L + (i / (n - 1)) * (R - L)).toFixed(1);
  const y = (val: number) => +(B - ((val - yMin) / Math.max(1, yMax - yMin)) * (B - T)).toFixed(1);
  const lineD = v.map((a, i) => `${i ? 'L' : 'M'}${x(i)} ${y(a)}`).join(' ');
  const bandD = `${hi.map((a, i) => `${i ? 'L' : 'M'}${x(i)} ${y(a)}`).join(' ')} ${lo
    .map((a, i) => ({ a, i }))
    .reverse()
    .map(({ a, i }) => `L${x(i)} ${y(a)}`)
    .join(' ')} Z`;
  const first = Math.round(v[0]!);
  const end = Math.round(v[n - 1]!);
  const label = `How well it knows you ${end >= first ? 'rose' : 'fell'} from ${first}% at answer ${points[0]!.seq} to ${end}% at answer ${last.seq}.${
    base === null ? '' : ` A guess from your profile alone is ${Math.round(base)}%.`
  }`;
  return (
    <div ref={ref} className="flex w-full flex-col gap-1.5">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        className="block overflow-visible"
      >
        <path d={bandD} fill="var(--ink10)" />
        {base !== null && (
          <>
            <path
              d={`M${L} ${y(base)} L${R} ${y(base)}`}
              fill="none"
              stroke="var(--slate)"
              strokeWidth={1.25}
              strokeDasharray="4 3"
            />
            <text
              x={R}
              y={y(base) + 16}
              style={{
                font: "500 12px 'Hanken Grotesk', sans-serif",
                fill: 'var(--slate)',
                textAnchor: 'end',
              }}
            >
              profile alone {Math.round(base)}%
            </text>
          </>
        )}
        <path
          d={lineD}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={x(0)} cy={y(v[0]!)} r={3} fill="var(--sheet)" stroke="var(--ink)" strokeWidth={1.5} />
        <circle cx={x(n - 1)} cy={y(v[n - 1]!)} r={3.5} fill="var(--ink)" />
        <text
          x={x(0) - 8}
          y={y(v[0]!) + 5}
          style={{
            font: "400 14px 'Newsreader', Georgia, serif",
            fill: 'var(--ink)',
            textAnchor: 'end',
            fontVariantNumeric: 'lining-nums tabular-nums',
          }}
        >
          {first}%
        </text>
        <text
          x={x(n - 1) + 8}
          y={y(v[n - 1]!) + 5}
          style={{
            font: "500 14px 'Newsreader', Georgia, serif",
            fill: 'var(--ink)',
            fontVariantNumeric: 'lining-nums tabular-nums',
          }}
        >
          {end}%
        </text>
      </svg>
      <div
        className="flex justify-between text-[12px] font-medium leading-4 text-slate"
        style={{ padding: `0 ${W - R}px 0 ${L}px` }}
      >
        <span>Answer {points[0]!.seq}</span>
        <span>Answer {last.seq}</span>
      </div>
    </div>
  );
}
