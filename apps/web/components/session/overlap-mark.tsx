import type { CSSProperties } from 'react';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const n = (v: number) => +v.toFixed(2);

/**
 * The signature element: "You" and "Mimic" as two circles, center distance d = 2r × (1 − F). Three regions:
 * You only (graphite/8), Mimic only (ink/10), the lens (ink/28). Calibrating: apart, mimic ring dashed.
 */
export function OverlapMark({
  size = 144,
  f = 0,
  calibrating = false,
  labels = true,
}: {
  size?: number;
  f?: number;
  calibrating?: boolean;
  labels?: boolean;
}) {
  const F = Math.max(0, Math.min(1, f));
  const r = labels ? size / 3.2 : size / 2.6;
  const sw = size < 40 ? 1.25 : 1.5;
  const pad = sw;
  let d = calibrating ? 2.25 * r : 2 * r * (1 - F);
  if (!calibrating && F < 0.995) d = Math.max(d, labels ? 3 : 2);
  const w = n(2 * r + d + 2 * pad);
  const h = n(2 * r + 2 * pad + (labels ? 22 : 0));
  const yx = n(pad + r);
  const mx = n(pad + r + d);
  const cy = n(pad + r);
  const R = n(r);
  const circ = (cx: number) =>
    `M${n(cx - r)} ${cy} a${R} ${R} 0 1 0 ${n(2 * r)} 0 a${R} ${R} 0 1 0 ${n(-2 * r)} 0 Z`;
  let youOnly: string;
  let mimicOnly: string;
  let lens: string;
  if (d >= 2 * r) {
    youOnly = circ(yx);
    mimicOnly = circ(mx);
    lens = 'M0 0';
  } else {
    const hx = n(yx + d / 2);
    const hh = Math.sqrt(r * r - (d / 2) ** 2);
    const T = `${hx} ${n(cy - hh)}`;
    const B = `${hx} ${n(cy + hh)}`;
    lens = `M${T} A${R} ${R} 0 0 1 ${B} A${R} ${R} 0 0 1 ${T} Z`;
    youOnly = `M${T} A${R} ${R} 0 1 0 ${B} A${R} ${R} 0 0 1 ${T} Z`;
    mimicOnly = `M${T} A${R} ${R} 0 1 1 ${B} A${R} ${R} 0 0 0 ${T} Z`;
  }
  const tr = `d 600ms ${EASE}, cx 600ms ${EASE}`;
  // CSS `d` animates the regions where supported; the attribute is the fallback.
  const region = (path: string, fill: string) =>
    ({ d: `path("${path}")`, fill, transition: tr }) as CSSProperties;
  const close = d < 48;
  const lab: CSSProperties = {
    font: "500 12px 'Hanken Grotesk', sans-serif",
    visibility: labels ? 'visible' : 'hidden',
  };
  const ly = n(2 * r + 2 * pad + 16);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={
        calibrating ? 'Your mimic is calibrating' : `How well it knows you: ${Math.round(F * 100)}%`
      }
      style={{ display: 'block', overflow: 'visible', flex: 'none' }}
    >
      <path d={youOnly} style={region(youOnly, 'var(--g8)')} />
      <path d={mimicOnly} style={region(mimicOnly, 'var(--ink10)')} />
      <path d={lens} style={region(lens, 'var(--ink28)')} />
      <circle cx={yx} cy={cy} r={R} style={{ fill: 'none', stroke: 'var(--graphite)', strokeWidth: sw }} />
      <circle
        cx={mx}
        cy={cy}
        r={R}
        style={{
          fill: 'none',
          stroke: 'var(--ink)',
          strokeWidth: sw,
          strokeDasharray: calibrating
            ? `${Math.max(2, r * 0.1).toFixed(1)} ${Math.max(1.5, r * 0.07).toFixed(1)}`
            : 'none',
          transition: `cx 600ms ${EASE}`,
        }}
      />
      {labels && (
        <>
          <text
            x={close ? n(yx + d / 2 - 5) : yx}
            y={ly}
            style={{ ...lab, fill: 'var(--graphite)', textAnchor: close ? 'end' : 'middle' }}
          >
            You
          </text>
          <text
            x={close ? n(yx + d / 2 + 5) : mx}
            y={ly}
            style={{ ...lab, fill: 'var(--ink)', textAnchor: close ? 'start' : 'middle' }}
          >
            Mimic
          </text>
        </>
      )}
    </svg>
  );
}
