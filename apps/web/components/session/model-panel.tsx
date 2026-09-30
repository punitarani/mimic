'use client';
import type { UiSnapshot } from '@mimic/core';
import { CATEGORY_INFO } from '@mimic/core/scope';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { notAsked } from '@/lib/scope-form';
import {
  bandOf,
  type Change,
  certaintyOf,
  chipText,
  type Fact,
  factRows,
  lastAnsweredSeq,
  pct,
  readingOf,
  sentence,
} from '@/lib/session-view';
import { cn } from '../ui';
import { FacetBar } from './facet-bar';
import { FidelityChart } from './fidelity-chart';
import { ChevronIcon, ExternalIcon, InfoIcon } from './icons';
import { OverlapMark } from './overlap-mark';

export interface ModelPanelProps {
  snap: UiSnapshot;
  facts?: Fact[];
  change: Change | null;
  /** Facets that just moved (id → previous position), shown with "Updated" for a few seconds. */
  moved: Map<string, number>;
  /** Mobile sheet: lead with What changed. */
  lead?: boolean;
  onFact: (factId: string, userState: 'active' | 'removed') => void;
  className?: string;
}

const H2 = 'm-0 text-[18px] font-semibold leading-[26px] text-graphite';
const H3 = 'm-0 text-[14px] font-semibold leading-5 text-slate';
const TEXT_BTN = 'border-0 bg-transparent text-[14px] font-medium leading-5 text-ink cursor-pointer';

/** The model panel (design: ModelPanel2). */
export function ModelPanel({ snap, facts, change, moved, lead = false, onFact, className }: ModelPanelProps) {
  const calibrating = snap.progress.answered < snap.progress.basics || !snap.fidelity;
  const changed = !calibrating && change && change.rows.length > 0 ? <WhatChanged change={change} /> : null;
  return (
    <div className={cn('flex flex-col gap-12 pt-2 pb-16', className)}>
      {lead && changed}
      <Fidelity snap={snap} calibrating={calibrating} moved={moved} />
      {!lead && changed}
      {!calibrating && (
        <>
          <Tendencies snap={snap} moved={moved} />
          <Learned snap={snap} fresh={change?.newInsights ?? new Set()} />
          <Knows facts={facts} onFact={onFact} />
          <Gaps snap={snap} />
        </>
      )}
    </div>
  );
}

function WhatChanged({ change }: { change: Change }) {
  return (
    <section aria-live="polite" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className={cn(H2, 'flex-none whitespace-nowrap')}>What changed</h2>
        <span className="min-w-0 text-right text-[14px] leading-5 text-slate [text-wrap:pretty]">
          {change.after}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {change.rows.map((r) => (
          <div
            key={`${r.k}:${r.v}`}
            className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 text-[14px] leading-5"
          >
            <span className="text-slate">{r.k}</span>
            <span className="text-graphite [text-wrap:pretty]">{r.v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function Fidelity({
  snap,
  calibrating,
  moved,
}: {
  snap: UiSnapshot;
  calibrating: boolean;
  moved: Map<string, number>;
}) {
  const info = usePopover();
  const f = snap.fidelity;
  const hist = snap.history;
  const prev = hist.length > 1 ? hist[hist.length - 2]! : null;
  const num = f ? pct(f.fidelity) : 0;
  const delta = f && prev ? num - pct(prev.fidelity) : null;
  // Lift on the fidelity scale, so it reads against the chart's "profile alone" line.
  const base =
    f && f.accBaseline !== null && f.selfConsistency > 0 ? f.accBaseline / f.selfConsistency : null;
  const lift = f && base !== null ? num - pct(Math.min(1, base)) : null;
  const chartPoints = hist.filter((h) => h.seq > snap.progress.basics);
  const lastSeq = lastAnsweredSeq(snap);
  const touched = lastSeq === null ? null : snap.facets.find((x) => x.supporting.includes(lastSeq));
  return (
    <section className="relative flex flex-col gap-4">
      <div ref={info.ref} className="flex items-center justify-between">
        <h2 className={H2}>How well it knows you</h2>
        <button
          type="button"
          aria-label="How this is measured"
          aria-expanded={info.open}
          onClick={() => info.setOpen(!info.open)}
          className={cn(
            'flex size-8 items-center justify-center rounded-[8px] p-0',
            info.open ? 'bg-ink10 text-ink' : 'text-slate hover:text-graphite',
          )}
        >
          <InfoIcon />
        </button>
        {info.open && (
          <div
            role="dialog"
            aria-label="How this is measured"
            className="absolute top-10 right-0 z-20 flex w-[340px] max-w-full flex-col gap-2.5 rounded-[8px] bg-sheet p-4 shadow-pop"
          >
            <span className="text-[14px] font-semibold leading-5 text-graphite">How this is measured</span>
            {f && !calibrating ? (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-[14px] leading-5 text-graphite">
                <span>Your mimic's guess was right</span>
                <Num className="text-ink">{pct(f.acc)}%</Num>
                <span>You agree with your own past answers</span>
                <Num>{pct(f.selfConsistency)}%</Num>
                <span className="border-t border-rule pt-1.5">
                  {pct(f.acc)} ÷ {pct(f.selfConsistency)}
                </span>
                <Num className="border-t border-rule pt-1.5 font-medium">{num}%</Num>
              </div>
            ) : (
              <span className="text-[14px] leading-5 text-graphite">
                The score starts after the first {snap.progress.basics} answers: how often your mimic's guess
                is right, divided by how often you agree with your own past answers.
              </span>
            )}
            <span className="text-[14px] leading-5 text-slate [text-wrap:pretty]">
              Some questions come back later to check how consistently you answer.
            </span>
          </div>
        )}
      </div>
      {calibrating ? (
        <>
          <OverlapMark size={144} calibrating />
          <span className="text-[16px] leading-6 text-graphite tabular-nums">
            Learning the basics: {Math.min(snap.progress.answered, snap.progress.basics)} of{' '}
            {snap.progress.basics}
          </span>
          {touched && touched.mean !== null && (
            <div className="flex flex-col gap-3 pt-4">
              <span className="text-[14px] font-semibold leading-5 text-slate">Your last answer touched</span>
              <FacetFor snap={snap} f={touched} moved={moved} />
            </div>
          )}
        </>
      ) : (
        f && (
          <>
            <div className="flex items-center gap-6">
              <OverlapMark size={144} f={f.fidelity} />
              <div className="flex items-baseline gap-2.5">
                <span className="font-serif text-[56px] leading-[60px] text-graphite [font-variant-numeric:lining-nums_tabular-nums]">
                  {num}%
                </span>
                {delta !== null && (
                  <span className="text-[14px] font-medium leading-5 text-slate tabular-nums">
                    {delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0'}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[16px] leading-6 text-graphite [text-wrap:pretty]">
                of the way to knowing you as well as you know yourself.
              </span>
              <span className="text-[14px] leading-5 text-slate">
                Range {pct(f.ciLow)}–{pct(f.ciHigh)}%, from {f.nScored} answer{f.nScored === 1 ? '' : 's'}
              </span>
            </div>
            {chartPoints.length >= 2 && (
              <div className="pt-1">
                <FidelityChart points={chartPoints} />
              </div>
            )}
            {lift !== null && (
              <span className="text-[14px] leading-5 text-graphite">
                {lift > 0
                  ? `${lift} point${lift === 1 ? '' : 's'} better than a guess from your profile alone.`
                  : lift < 0
                    ? `${-lift} point${lift === -1 ? '' : 's'} worse than a guess from your profile alone.`
                    : 'Level with a guess from your profile alone.'}
              </span>
            )}
          </>
        )
      )}
    </section>
  );
}

function Num({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-right font-serif text-[16px] leading-5 [font-variant-numeric:lining-nums_tabular-nums]',
        className,
      )}
    >
      {children}
    </span>
  );
}

type SnapFacet = UiSnapshot['facets'][number];

function answersFor(snap: UiSnapshot, f: SnapFacet) {
  const bySeq = new Map<number, { q: string; a: string }>();
  for (const i of snap.insights) for (const e of i.evidence) bySeq.set(e.seq, { q: e.q, a: e.answer });
  return f.supporting
    .map((s) => bySeq.get(s))
    .filter((x): x is { q: string; a: string } => !!x)
    .reverse();
}

function FacetFor({ snap, f, moved }: { snap: UiSnapshot; f: SnapFacet; moved: Map<string, number> }) {
  return (
    <FacetBar
      label={sentence(f.name)}
      reading={readingOf(f)}
      lo={f.low}
      hi={f.high}
      pos={f.mean}
      band={bandOf(f)}
      certainty={certaintyOf(f)}
      from={moved.get(f.id) ?? null}
      answers={answersFor(snap, f)}
    />
  );
}

const SHOWN_PER_GROUP = 2;

function Tendencies({ snap, moved }: { snap: UiSnapshot; moved: Map<string, number> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const order = [...snap.groups, ...snap.facets.map((f) => f.group).filter((g) => !snap.groups.includes(g))];
  const groups = [...new Set(order)]
    .map((g) => {
      const all = snap.facets.filter((f) => f.group === g);
      // Estimated facets first (ontology order), then the ones without enough answers.
      const known = all.filter((f) => f.mean !== null);
      return { name: g, items: [...known, ...all.filter((f) => f.mean === null)], known: known.length };
    })
    .filter((g) => g.known > 0);
  if (!groups.length) return null;
  return (
    <section className="flex flex-col gap-6">
      <h2 className={H2}>Your tendencies</h2>
      {groups.map((g) => {
        const all = open.has(g.name);
        const shown = all ? g.items : g.items.slice(0, SHOWN_PER_GROUP);
        return (
          <div key={g.name} className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className={H3}>{g.name}</h3>
              {g.items.length > SHOWN_PER_GROUP && (
                <button
                  type="button"
                  aria-expanded={all}
                  className={cn(TEXT_BTN, 'py-1')}
                  onClick={() =>
                    setOpen((s) => {
                      const n = new Set(s);
                      if (all) n.delete(g.name);
                      else n.add(g.name);
                      return n;
                    })
                  }
                >
                  {all ? 'Show fewer' : 'Show all'}
                </button>
              )}
            </div>
            {shown.map((f) => (
              <FacetFor key={f.id} snap={snap} f={f} moved={moved} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

const INSIGHTS_SHOWN = 3;

function Learned({ snap, fresh }: { snap: UiSnapshot; fresh: Set<string> }) {
  const [all, setAll] = useState(false);
  if (!snap.insights.length) return null;
  const shown = all ? snap.insights : snap.insights.slice(0, INSIGHTS_SHOWN);
  return (
    <section className="flex flex-col gap-4">
      <h2 className={H2}>What it's learned</h2>
      <div className="flex flex-col gap-3">
        {shown.map((i) => (
          <Insight key={i.id} insight={i} isNew={fresh.has(i.id)} />
        ))}
      </div>
      {snap.insights.length > INSIGHTS_SHOWN && (
        <button type="button" className={cn(TEXT_BTN, 'self-start py-1')} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${snap.insights.length}`}
        </button>
      )}
    </section>
  );
}

function Insight({ insight, isNew }: { insight: UiSnapshot['insights'][number]; isNew: boolean }) {
  // A new insight enters with an ink/10 wash that fades over 2.4 s.
  const [wash, setWash] = useState(isNew);
  useEffect(() => {
    if (!isNew) return;
    setWash(true);
    const t = setTimeout(() => setWash(false), 60);
    return () => clearTimeout(t);
  }, [isNew]);
  return (
    <div
      className="-mx-3 flex flex-col gap-2 rounded-[8px] p-3 transition-[background-color] duration-[2400ms] ease-out"
      style={{ backgroundColor: wash ? 'var(--ink10)' : 'transparent' }}
    >
      {isNew && <span className="text-[12px] font-medium leading-4 text-ink">New</span>}
      <p className="m-0 text-[16px] leading-6 text-graphite [text-wrap:pretty]">{insight.text}</p>
      <div className="flex flex-wrap gap-2">
        {insight.evidence.map((e) => (
          <EvidenceChip key={e.seq} q={e.q} answer={e.answer} />
        ))}
      </div>
    </div>
  );
}

/** Evidence chip: the answer text (never a question number); opens the question it answered. */
function EvidenceChip({ q, answer }: { q: string; answer: string }) {
  const pop = usePopover();
  return (
    <div ref={pop.ref} className="relative">
      <button
        type="button"
        title={answer}
        aria-expanded={pop.open}
        onClick={() => pop.setOpen(!pop.open)}
        className={cn(
          'h-7 cursor-pointer whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium leading-4 focus-visible:rounded-full',
          pop.open
            ? 'border-ink bg-ink10 text-ink'
            : 'border-rule bg-fog text-graphite hover:bg-[linear-gradient(var(--g8),var(--g8))]',
        )}
      >
        {chipText(answer)}
      </button>
      {pop.open && (
        <div
          role="dialog"
          aria-label="The question behind this"
          className="absolute top-full left-0 z-20 mt-2 flex w-[340px] max-w-[calc(100vw-48px)] flex-col gap-2 rounded-[8px] bg-sheet p-4 shadow-pop"
        >
          <span className="font-serif text-[16px] leading-[22px] text-graphite">{q}</span>
          <span className="text-[14px] leading-5 text-graphite">You: {answer}</span>
        </div>
      )}
    </div>
  );
}

function Knows({
  facts,
  onFact,
}: {
  facts: Fact[] | undefined;
  onFact: (id: string, userState: 'active' | 'removed') => void;
}) {
  const [open, setOpen] = useState(false);
  if (!facts) return null;
  const { profile, told } = factRows(facts);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const summary =
    profile.length + told.length === 0
      ? 'Nothing yet. Facts from your profile and what you tell it show up here.'
      : `${plural(profile.length, 'fact', 'facts')} from your profile and ${told.length} from what you told us. Remove anything you'd rather it didn't use.`;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className={H2}>What it knows about you</h2>
        {profile.length + told.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cn(TEXT_BTN, 'flex h-8 items-center gap-1 p-0')}
          >
            {open ? 'Hide' : 'Show'}
            <ChevronIcon style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
          </button>
        )}
      </div>
      {!open ? (
        <p className="m-0 text-[14px] leading-5 text-slate [text-wrap:pretty]">{summary}</p>
      ) : (
        [
          { name: 'From your profile', items: profile },
          { name: 'From what you told us', items: told },
        ]
          .filter((g) => g.items.length)
          .map((g) => (
            <div key={g.name} className="flex flex-col gap-1">
              <h3 className={cn(H3, 'mb-1')}>{g.name}</h3>
              {g.items.map((it) => (
                <div key={it.id} className="flex flex-col gap-0.5 border-b border-rule py-2">
                  <span
                    className={cn(
                      'text-[14px] leading-5',
                      it.removed ? 'text-slate line-through' : 'text-graphite',
                    )}
                  >
                    {it.text}
                  </span>
                  <div className="flex items-center justify-between gap-3">
                    {it.url ? (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[12px] leading-4 text-slate hover:text-graphite"
                      >
                        {it.source}
                        <ExternalIcon />
                      </a>
                    ) : (
                      <span className="text-[12px] leading-4 text-slate">{it.source}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => onFact(it.id, it.removed ? 'active' : 'removed')}
                      className={cn(
                        'h-8 cursor-pointer border-0 bg-transparent px-1 text-[14px] font-medium leading-5',
                        it.removed ? 'text-ink' : 'text-graphite',
                      )}
                    >
                      {it.removed ? 'Undo' : 'Remove'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))
      )}
    </section>
  );
}

function Gaps({ snap }: { snap: UiSnapshot }) {
  const names = new Map(snap.facets.map((f) => [f.id, sentence(f.name)]));
  // Topics the person turned off (ADR-0043): never asked, so never "unexplored".
  const off = notAsked(snap.mimic.scope).map((c) => CATEGORY_INFO[c].name);
  if (!snap.unexplored.length && !off.length) return null;
  return (
    <section className="flex flex-col gap-4">
      <h2 className={H2}>Not explored yet</h2>
      {snap.unexplored.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {snap.unexplored.map((id) => (
            <span
              key={id}
              className="inline-flex h-7 items-center rounded-full border border-rule px-3 text-[12px] font-medium leading-4 text-slate"
            >
              {names.get(id) ?? id}
            </span>
          ))}
        </div>
      )}
      {off.length > 0 && (
        <p className="m-0 text-[13px] leading-5 text-slate">
          Not asked about: {off.join('; ')}. You can change this in Topics and consent, in the menu.
        </p>
      )}
    </section>
  );
}
