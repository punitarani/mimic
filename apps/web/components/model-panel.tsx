'use client';
import type { UiSnapshot } from '@mimic/core';
import dynamic from 'next/dynamic';

const KgGraph = dynamic(() => import('./kg-graph').then((m) => m.KgGraph), {
  ssr: false,
  loading: () => <div className="h-[520px] rounded-[10px] bg-surface" />,
});

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The signature element (PLAN §10.2): "You" and "Mimic" as two circles whose overlap grows with fidelity.
 * At fidelity 1 they coincide; at 0 they only touch.
 */
export function FidelityRings({
  fidelity,
  size = 132,
  labels = true,
}: {
  fidelity: number | null;
  size?: number;
  labels?: boolean;
}) {
  const f = fidelity ?? 0;
  const r = 30;
  const gap = 2 * r * (1 - f);
  const you = 60 - gap / 2;
  const mimic = 60 + gap / 2;
  const svg = (
    <svg
      width={size}
      height={size * 0.56}
      viewBox="0 0 120 67"
      role="img"
      aria-label={fidelity === null ? 'Not enough answers yet' : `You and your mimic overlap ${pct(f)}`}
    >
      <circle
        className="fidelity-motion"
        cx={you}
        cy="33.5"
        r={r}
        fill="var(--color-graphite)"
        fillOpacity="0.82"
      />
      <circle
        className="fidelity-motion"
        cx={mimic}
        cy="33.5"
        r={r}
        fill="var(--color-ink)"
        fillOpacity="0.62"
      />
    </svg>
  );
  if (!labels) return svg;
  return (
    <div className="flex shrink-0 flex-col items-center" style={{ width: size }}>
      {svg}
      <div className="mt-1 flex w-full justify-between px-2 text-[12px] text-muted" aria-hidden="true">
        <span>You</span>
        <span>Mimic</span>
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - v * h}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="overflow-visible">
      <polyline points={pts} fill="none" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function FidelityHeadline({ snap }: { snap: UiSnapshot }) {
  const f = snap.fidelity;
  const scored = f && f.nScored > 0;
  const lift = f && f.accBaseline !== null ? Math.round((f.acc - f.accBaseline) * 100) : null;
  return (
    <section aria-labelledby="fidelity-h" className="flex items-center gap-4">
      <FidelityRings fidelity={scored ? f.fidelity : null} />
      <div className="min-w-0">
        <h2 id="fidelity-h" className="sr-only">
          Fidelity
        </h2>
        {scored ? (
          <>
            <p className="text-[15px] leading-snug">
              Predicts you <span className="tabular font-semibold">{pct(f.fidelity)}</span> as well as you
              predict yourself
            </p>
            <p className="mt-1 text-[13px] text-muted tabular">
              {pct(f.ciLow)}–{pct(f.ciHigh)} · {f.state} · {f.nRepeats} repeat{f.nRepeats === 1 ? '' : 's'}
            </p>
            {lift !== null && (
              <p className="mt-1 text-[13px] text-muted">
                {lift >= 0 ? `${lift} points better` : `${-lift} points worse`} than a guess from your profile
                alone
              </p>
            )}
            <div className="mt-2">
              <Sparkline values={snap.history.map((h) => h.fidelity)} />
            </div>
          </>
        ) : (
          <p className="text-[15px] text-muted">
            Answer a few questions to see how well your mimic predicts you.
          </p>
        )}
      </div>
    </section>
  );
}

/** The knowledge graph built from the person's answers and sources. */
export function KgMap({ snap }: { snap: UiSnapshot }) {
  return (
    <section aria-labelledby="kg-h">
      <h2 id="kg-h" className="text-sm font-medium">
        Your map
      </h2>
      <div className="mt-2">
        <KgGraph kg={snap.kg} facets={snap.facets} />
      </div>
    </section>
  );
}
