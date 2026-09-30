'use client';
import { forwardRef, type KeyboardEvent, useEffect, useState } from 'react';
import { cn } from '../ui';

export interface OptionButtonProps {
  label: string;
  /** Keyboard hint shown on desktop: 1–5, Y or N. */
  hint?: string;
  /** Mimic's probability for this option, shown after the reveal (0–100). */
  pct?: number | null;
  /** The person's answer: 2 px graphite border, graphite/8 fill and the You tag. */
  you?: boolean;
  /** The mimic's guess: the Mimic tag. */
  mimic?: boolean;
  center?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  onPick: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

/** Option button (design: OptionButton2). Padding absorbs the picked border so nothing shifts. */
export const OptionButton = forwardRef<HTMLButtonElement, OptionButtonProps>(function OptionButton(
  {
    label,
    hint,
    pct,
    you = false,
    mimic = false,
    center = false,
    disabled = false,
    tabIndex,
    onPick,
    onKeyDown,
  },
  ref,
) {
  const hasBar = typeof pct === 'number';
  // The bar grows from 0 on reveal (240 ms).
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!hasBar) {
      setGrown(false);
      return;
    }
    const f = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(f);
  }, [hasBar]);
  const tags = hasBar || you || mimic;
  return (
    // biome-ignore lint/a11y/useSemanticElements: large tappable options with keyboard shortcuts, in a radiogroup
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={you}
      tabIndex={tabIndex}
      disabled={disabled}
      onClick={onPick}
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex min-h-14 w-full items-center overflow-hidden rounded-[12px] bg-sheet text-left select-none focus-visible:rounded-[12px]',
        you
          ? 'border-2 border-graphite bg-[linear-gradient(var(--g8),var(--g8))] px-[15px] py-[13px] lg:px-[19px] lg:py-[15px]'
          : 'border border-rule px-4 py-[14px] lg:px-5 lg:py-4',
        disabled ? 'cursor-default' : 'cursor-pointer',
        !you && !disabled && 'hover:border-slate',
      )}
    >
      {hasBar && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-ink16 transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: `${grown ? pct : 0}%` }}
        />
      )}
      <span className="relative flex w-full items-center gap-3">
        {hint && (
          <span className="hidden w-3 flex-none text-[12px] font-medium leading-4 text-slate lg:block">
            {hint}
          </span>
        )}
        <span
          className={cn(
            'flex-1 text-[16px] font-medium leading-[22px] text-graphite [text-wrap:pretty] lg:text-[17px] lg:leading-6',
            center && 'text-center',
          )}
        >
          {label}
        </span>
        {(tags || !center) && (
          <span
            className={cn(
              'flex flex-none items-center justify-end gap-2',
              !center && 'min-w-[112px] lg:min-w-0',
              !tags && 'lg:hidden',
            )}
          >
            {hasBar && (
              <span className="min-w-9 text-right text-[14px] leading-5 text-ink tabular-nums">{pct}%</span>
            )}
            {mimic && <Tag tone="ink">Mimic</Tag>}
            {you && <Tag tone="graphite">You</Tag>}
          </span>
        )}
      </span>
    </button>
  );
});

function Tag({ tone, children }: { tone: 'ink' | 'graphite'; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-medium leading-4 text-fog',
        tone === 'ink' ? 'bg-ink' : 'bg-graphite',
      )}
    >
      {children}
    </span>
  );
}
