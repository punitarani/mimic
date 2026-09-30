'use client';
import { useState } from 'react';
import type { Certainty } from '@/lib/session-view';

export interface FacetBarProps {
  label: string;
  reading: string;
  lo: string;
  hi: string;
  pos: number | null;
  band: number;
  certainty: Certainty;
  /** Previous position when it just moved: dashed ring, trail and "Updated". */
  from?: number | null;
  /** The answers behind the estimate, shown on hover or focus. */
  answers?: Array<{ q: string; a: string }>;
}

/** Facet bar (design: FacetBar2): estimate dot, certainty band, poles below. Hollow dot when certainty is low. */
export function FacetBar({
  label,
  reading,
  lo,
  hi,
  pos,
  band,
  certainty,
  from,
  answers = [],
}: FacetBarProps) {
  const [open, setOpen] = useState(false);
  const none = certainty === 'none' || pos === null;
  const p = none ? 0.5 : pos;
  const bw = none ? 1 : band;
  const hollow = none || certainty === 'low';
  const l = Math.max(0, p - bw / 2);
  const wd = Math.min(1, p + bw / 2) - l;
  const moved = typeof from === 'number';
  const a = Math.min(p, from ?? p);
  const b = Math.max(p, from ?? p);
  const popover = open && answers.length > 0;
  const hasAnswers = answers.length > 0;
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={hasAnswers ? popover : undefined}
        aria-label={`${label}: ${none ? 'not enough answers yet' : `${reading}, ${certainty} certainty`}`}
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex w-full cursor-default flex-col gap-1.5 rounded-[4px] border-0 bg-transparent p-0 text-left focus-visible:outline-offset-4"
      >
        <span className="flex w-full items-center justify-between gap-3 text-[14px] leading-5">
          <span className="flex items-center gap-2 text-graphite">
            {label}
            {moved && (
              <span className="inline-flex h-5 items-center rounded-full bg-ink10 px-2 text-[12px] font-medium leading-4 text-ink">
                Updated
              </span>
            )}
          </span>
          <span className="text-right text-slate">{none ? 'Not enough answers yet.' : reading}</span>
        </span>
        <span className="relative block h-3 w-full" aria-hidden="true">
          <span className="absolute inset-x-0 top-[5px] h-0.5 bg-rule" />
          <span
            className="absolute top-0 h-3 rounded-full bg-ink16"
            style={{ left: `${l * 100}%`, width: `${wd * 100}%` }}
          />
          {moved && (
            <>
              <span
                className="absolute top-px -ml-[5px] size-2.5 rounded-full border-[1.5px] border-dashed border-ink opacity-60"
                style={{ left: `${(from ?? 0) * 100}%` }}
              />
              <span
                className="absolute top-[5px] h-0.5 bg-ink"
                style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
              />
            </>
          )}
          <span
            className="absolute top-px -ml-[5px] size-2.5 rounded-full border-[1.5px] border-ink transition-[left] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              left: `${p * 100}%`,
              backgroundColor: hollow ? 'var(--sheet)' : 'var(--ink)',
              boxShadow: moved ? '0 0 0 4px var(--ink16)' : 'none',
            }}
          />
        </span>
        <span className="flex w-full justify-between gap-3 text-[12px] font-medium leading-4 text-slate">
          <span>{lo}</span>
          <span className="text-right">{hi}</span>
        </span>
      </button>
      {popover && (
        <div
          role="tooltip"
          className="absolute top-[calc(100%+8px)] left-0 z-10 flex w-[340px] max-w-[calc(100vw-40px)] flex-col gap-3 rounded-[8px] bg-sheet p-4 shadow-pop"
        >
          <span className="text-[14px] font-semibold leading-5 text-graphite">
            Based on {answers.length} answer{answers.length === 1 ? '' : 's'}
          </span>
          {answers.slice(0, 4).map((x) => (
            <div key={x.q} className="flex flex-col gap-0.5">
              <span className="truncate font-serif text-[14px] leading-5 text-slate">{x.q}</span>
              <span className="text-[14px] leading-5 text-graphite">You: {x.a}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
