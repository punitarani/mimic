'use client';
import type { KeyboardEvent, Ref } from 'react';
import { expectedPoint } from '@/lib/session-view';
import { cn } from '../ui';

export interface ScaleControlProps {
  keys: string[];
  lo: string;
  hi: string;
  picked: string | null;
  /** Mimic's distribution (0–1 per key), shown after the reveal. */
  dist?: Record<string, number> | null;
  disabled?: boolean;
  onPick: (key: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  refFor?: (i: number) => Ref<HTMLButtonElement>;
  tabIndexFor?: (i: number) => number;
}

/** Five-point scale (design: ScaleControl): joined segments; after the reveal, the mimic's bars and expected tick. */
export function ScaleControl({
  keys,
  lo,
  hi,
  picked,
  dist,
  disabled,
  onPick,
  onKeyDown,
  refFor,
  tabIndexFor,
}: ScaleControlProps) {
  const pcts = dist ? keys.map((k) => Math.round((dist[k] ?? 0) * 100)) : null;
  // 1.2 px per point as designed; scaled down when a bar would outgrow the 76 px area.
  const unit = pcts ? Math.min(1.2, 56 / Math.max(1, ...pcts)) : 1.2;
  const exp = dist ? expectedPoint(keys, dist) : null;
  return (
    <div className="flex w-full flex-col gap-2">
      <div role="radiogroup" aria-label="Your answer" className="flex">
        {keys.map((k, i) => {
          const on = picked === k;
          return (
            // biome-ignore lint/a11y/useSemanticElements: joined scale segments with keyboard shortcuts
            <button
              key={k}
              ref={refFor?.(i)}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${i + 1} of 5`}
              tabIndex={tabIndexFor?.(i)}
              disabled={disabled}
              onClick={() => onPick(k)}
              onKeyDown={onKeyDown}
              className={cn(
                'relative flex h-14 flex-1 items-center justify-center border-y border-r border-rule text-[16px] font-medium leading-[22px] tabular-nums focus-visible:z-10 lg:text-[17px] lg:leading-6',
                i === 0 && 'rounded-l-[12px] border-l focus-visible:rounded-l-[12px]',
                i === keys.length - 1 && 'rounded-r-[12px] focus-visible:rounded-r-[12px]',
                i > 0 && i < keys.length - 1 && 'focus-visible:rounded-none',
                on ? 'bg-graphite text-fog' : 'bg-sheet text-graphite',
                !on && !disabled && 'hover:bg-[linear-gradient(var(--g8),var(--g8))]',
                disabled ? 'cursor-default' : 'cursor-pointer',
              )}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      {pcts && exp !== null && (
        <div
          role="img"
          aria-label={`Your mimic's guess: ${pcts.map((v, i) => `${v}% for ${i + 1}`).join(', ')}`}
          className="relative flex h-[76px] border-b border-rule"
        >
          {pcts.map((v, i) => (
            <div key={keys[i]} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[12px] font-medium leading-4 text-ink tabular-nums">{v}%</span>
              <div className="w-6 bg-ink28 lg:w-8" style={{ height: Math.round(v * unit) }} />
            </div>
          ))}
          <div
            className="absolute top-5 bottom-0 -ml-px w-0.5 bg-ink"
            style={{ left: `${((exp - 0.5) / 5) * 100}%` }}
          />
        </div>
      )}
      <div className="flex justify-between gap-4 text-[14px] leading-5 text-slate">
        <span>{lo}</span>
        <span className="text-right">{hi}</span>
      </div>
    </div>
  );
}
