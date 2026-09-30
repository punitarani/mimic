/**
 * Button styles with no 'use client' directive, so server components (the landing page, /lab) can call them too.
 * `components/ui.tsx` re-exports everything here.
 */

export function cn(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

// `aria-disabled:` twins of each `disabled:` state make the same look work on links, which can't be `disabled`.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-graphite text-fog hover:bg-graphite-soft disabled:bg-line-strong aria-disabled:bg-line-strong',
  secondary:
    'bg-raised text-graphite border border-line hover:border-line-strong disabled:text-muted aria-disabled:text-muted',
  ghost: 'text-graphite-soft hover:text-graphite hover:bg-surface',
  danger: 'bg-rust text-fog hover:bg-rust/90 disabled:opacity-60 aria-disabled:opacity-60',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-[15px]',
  lg: 'h-12 px-6 text-base',
};

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition-colors motion-reduce:transition-none ' +
  'disabled:cursor-not-allowed aria-disabled:pointer-events-none';

/**
 * Classes for a button, or for a link that should look like one (downloads, navigation). `className` adds classes; it
 * doesn't reliably override the variant's or size's own (`cn` doesn't resolve Tailwind conflicts), so pick the variant
 * and size you need instead.
 */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(BASE, SIZES[size], VARIANTS[variant], className);
}
