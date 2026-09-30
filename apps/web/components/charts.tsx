/** Small server-renderable SVG charts for /lab. */

const PALETTE = ['#2d4fb3', '#a9543a', '#4a7f62', '#7a5ba8', '#66707d', '#c08a2d'];

export function LineChart({
  series,
  xLabel,
  yLabel,
  height = 220,
  yMax = 1,
}: {
  series: Array<{ name: string; points: Array<{ x: number; y: number }> }>;
  xLabel: string;
  yLabel: string;
  height?: number;
  yMax?: number;
}) {
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 32 };
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const xMax = Math.max(1, ...xs);
  const sx = (x: number) => pad.l + ((x - 1) / Math.max(1, xMax - 1)) * (W - pad.l - pad.r);
  const sy = (y: number) => H - pad.b - (y / yMax) * (H - pad.t - pad.b);
  if (!xs.length) return <p className="text-[13px] text-muted">No data yet.</p>;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${yLabel} by ${xLabel}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(t * yMax)} y2={sy(t * yMax)} stroke="#e3e7ec" />
            <text x={pad.l - 6} y={sy(t * yMax) + 4} fontSize="10" textAnchor="end" fill="#66707d">
              {Math.round(t * yMax * 100)}%
            </text>
          </g>
        ))}
        {series.map((s, i) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={PALETTE[i % PALETTE.length]}
            strokeWidth="2"
            strokeLinejoin="round"
            points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
          />
        ))}
        <text x={(W + pad.l) / 2} y={H - 6} fontSize="11" textAnchor="middle" fill="#66707d">
          {xLabel}
        </text>
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-3 text-[12px] text-muted">
        {series.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: PALETTE[i % PALETTE.length] }} />
            {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function ScatterChart({
  points,
  xLabel,
  yLabel,
}: {
  points: Array<{ label: string; x: number; y: number }>;
  xLabel: string;
  yLabel: string;
}) {
  const W = 640;
  const H = 220;
  const pad = { l: 40, r: 16, t: 12, b: 32 };
  if (!points.length) return <p className="text-[13px] text-muted">No data yet.</p>;
  const xMax = Math.max(...points.map((p) => p.x)) * 1.15 || 1;
  const sx = (x: number) => pad.l + (x / xMax) * (W - pad.l - pad.r);
  const sy = (y: number) => H - pad.b - y * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${yLabel} vs ${xLabel}`}>
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="#e3e7ec" />
          <text x={pad.l - 6} y={sy(t) + 4} fontSize="10" textAnchor="end" fill="#66707d">
            {Math.round(t * 100)}%
          </text>
        </g>
      ))}
      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r="5" fill={PALETTE[i % PALETTE.length]} />
          <text x={sx(p.x) + 8} y={sy(p.y) + 4} fontSize="11" fill="#262a31">
            {p.label}
          </text>
        </g>
      ))}
      <text x={(W + pad.l) / 2} y={H - 6} fontSize="11" textAnchor="middle" fill="#66707d">
        {xLabel}
      </text>
    </svg>
  );
}
