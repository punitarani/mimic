'use client';
import type { UiSnapshot } from '@mimic/core';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { cn } from './ui';

const KgGraph = dynamic(() => import('./kg-graph').then((m) => m.KgGraph), {
  ssr: false,
  loading: () => <div className="h-[220px] rounded-[10px] bg-surface" />,
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

export function FacetBars({ snap }: { snap: UiSnapshot }) {
  const [hover, setHover] = useState<string | null>(null);
  const evidence = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of snap.insights) for (const e of i.evidence) m.set(e.seq, `${e.q} → ${e.answer}`);
    return m;
  }, [snap.insights]);
  const groups = [...new Set(snap.facets.map((f) => f.group))];
  return (
    <section aria-labelledby="facets-h">
      <h2 id="facets-h" className="text-sm font-medium">
        How you decide
      </h2>
      <p className="text-[12px] text-muted">Marker = estimate · band = certainty</p>
      <div className="mt-3 space-y-4">
        {groups.map((g) => (
          <div key={g}>
            <h3 className="text-[12px] font-medium text-muted">{g}</h3>
            <ul className="mt-1.5 space-y-1.5">
              {snap.facets
                .filter((f) => f.group === g)
                .map((f) => (
                  <li
                    key={f.id}
                    className="group relative"
                    onMouseEnter={() => setHover(f.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div className="flex items-baseline justify-between text-[12px]">
                      <span className="text-graphite-soft">{f.low}</span>
                      <span className="text-graphite-soft">{f.high}</span>
                    </div>
                    <FacetBar mean={f.mean} certainty={f.certainty} name={f.name} />
                    {hover === f.id && f.supporting.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-[8px] border border-line bg-raised p-2 text-[12px] shadow-[var(--shadow-card)]">
                        <p className="font-medium">Based on answers {f.supporting.join(', ')}</p>
                        {f.supporting
                          .map((s) => evidence.get(s))
                          .filter(Boolean)
                          .slice(0, 3)
                          .map((t) => (
                            <p key={t} className="mt-0.5 text-muted">
                              {t}
                            </p>
                          ))}
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function FacetBar({
  mean,
  certainty,
  name,
}: {
  mean: number | null;
  certainty: number | null;
  name: string;
}) {
  // The band narrows as certainty grows: width = (1 − certainty) of the track, centered on the estimate.
  const band = certainty === null ? 1 : Math.max(0.06, 1 - certainty);
  const left = mean === null ? 0 : Math.min(1 - band, Math.max(0, mean - band / 2));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a styled estimate + certainty band; <meter> can't draw the band
    <div
      className="relative h-2 rounded-full bg-line/70"
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={mean === null ? undefined : Math.round(mean * 100)}
      aria-valuetext={
        mean === null
          ? 'not explored yet'
          : `${Math.round(mean * 100)} of 100, certainty ${Math.round((certainty ?? 0) * 100)}%`
      }
    >
      {mean !== null && (
        <>
          <div
            className="absolute inset-y-0 rounded-full bg-ink-soft"
            style={{ left: `${left * 100}%`, width: `${band * 100}%` }}
          />
          <div
            className="absolute -top-0.5 h-3 w-1 -translate-x-1/2 rounded-full bg-ink"
            style={{ left: `${mean * 100}%` }}
          />
        </>
      )}
    </div>
  );
}

export function Insights({ snap }: { snap: UiSnapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="insights-h">
      <h2 id="insights-h" className="text-sm font-medium">
        What it's learned
      </h2>
      {snap.insights.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          Insights appear after a few answers. Each one cites the answers behind it.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {snap.insights.map((i) => (
            <li key={i.id} className="rounded-[10px] border border-line bg-raised p-3">
              <p className="text-[14px] leading-snug">{i.text}</p>
              <button
                type="button"
                className="mt-1 text-[12px] text-ink underline underline-offset-2"
                aria-expanded={open === i.id}
                onClick={() => setOpen(open === i.id ? null : i.id)}
              >
                From answers {i.evidence.map((e) => e.seq).join(', ')}
              </button>
              {open === i.id && (
                <ul className="mt-2 space-y-1 text-[12px] text-muted">
                  {i.evidence.map((e) => (
                    <li key={e.seq}>
                      <span className="text-graphite-soft">#{e.seq}</span> {e.q} →{' '}
                      <span className="text-graphite">{e.answer}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Coverage({ snap }: { snap: UiSnapshot }) {
  const names = new Map(snap.facets.map((f) => [f.id, f.name]));
  if (!snap.unexplored.length) return null;
  return (
    <section aria-labelledby="coverage-h">
      <h2 id="coverage-h" className="text-sm font-medium">
        Not explored yet
      </h2>
      <p className="mt-2 flex flex-wrap gap-1.5">
        {snap.unexplored.map((id) => (
          <span key={id} className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">
            {names.get(id) ?? id}
          </span>
        ))}
      </p>
    </section>
  );
}

export function ModelPanel({ snap, className }: { snap: UiSnapshot; className?: string }) {
  return (
    <div className={cn('space-y-8', className)}>
      <FidelityHeadline snap={snap} />
      <FacetBars snap={snap} />
      <Insights snap={snap} />
      <section aria-labelledby="kg-h">
        <h2 id="kg-h" className="text-sm font-medium">
          Your map
        </h2>
        <div className="mt-2">
          <KgGraph kg={snap.kg} />
        </div>
      </section>
      <Coverage snap={snap} />
    </div>
  );
}
