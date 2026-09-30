'use client';
import { useEffect, useRef, useState } from 'react';
import { type Theme, useTheme } from '@/lib/theme';
import { cn } from '../ui';
import { ConfirmDialog } from './confirm-dialog';
import { Dots, DownloadIcon, TrashIcon } from './icons';

export interface SessionMenuProps {
  mimicId: string;
  /** Mobile: Finish for now moves into the menu. */
  onFinish?: () => void;
  /** Null when this mimic's config never reveals guesses (the toggle is then hidden). */
  guesses: boolean | null;
  onGuesses: (on: boolean) => void;
  onDelete: () => Promise<void>;
  compact?: boolean;
}

const ITEM = 'flex min-h-11 w-full items-center gap-2.5 rounded-[8px] px-3 text-left text-[14px] leading-5';

/** The top bar's ⋯ menu (design: Top bar and menu). */
export function SessionMenu({
  mimicId,
  onFinish,
  guesses,
  onGuesses,
  onDelete,
  compact = false,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [theme, setTheme] = useTheme();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Arrow keys move between menu items.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div ref={root} className={cn(!compact && 'relative')}>
      <button
        ref={button}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center justify-center rounded-[8px] p-0',
          compact ? 'size-11' : 'size-9',
          open ? 'bg-g8' : 'hover:bg-g8',
        )}
      >
        <Dots />
      </button>
      {open && (
        <div
          role="menu"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className={cn(
            'absolute z-30 flex flex-col rounded-[12px] bg-sheet p-2 shadow-pop',
            compact ? 'top-[52px] right-2 w-[300px]' : 'top-[calc(100%+4px)] right-0 w-[320px]',
          )}
        >
          {onFinish && (
            <>
              <button
                type="button"
                role="menuitem"
                className={cn(ITEM, 'font-medium text-graphite hover:bg-g8')}
                onClick={() => {
                  setOpen(false);
                  onFinish();
                }}
              >
                Finish for now
              </button>
              <Divider />
            </>
          )}
          {guesses !== null && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={guesses}
              onClick={() => onGuesses(!guesses)}
              className={cn(ITEM, 'justify-between gap-4 text-graphite hover:bg-g8')}
            >
              Show guesses after each answer
              <span
                aria-hidden="true"
                className={cn(
                  'relative h-5 w-9 flex-none rounded-full transition-colors',
                  guesses ? 'bg-graphite' : 'bg-rule',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-4 rounded-full bg-fog transition-[left]',
                    guesses ? 'left-[18px]' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          )}
          <div className={cn(ITEM, 'justify-between gap-4 text-graphite')}>
            <span id="theme-label">Theme</span>
            <div
              role="radiogroup"
              aria-labelledby="theme-label"
              className="flex overflow-hidden rounded-[8px] border border-rule text-[12px] font-medium leading-4"
            >
              {(['light', 'dark', 'system'] as Theme[]).map((t, i) => (
                <button
                  key={t}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === t}
                  onClick={() => setTheme(t)}
                  className={cn(
                    'py-1.5',
                    compact ? 'px-2' : 'px-2.5',
                    i > 0 && 'border-l border-rule',
                    theme === t ? 'bg-graphite text-fog' : 'text-graphite hover:bg-g8',
                  )}
                >
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <Divider />
          <a
            role="menuitem"
            href={`/api/mimics/${mimicId}/export`}
            download
            onClick={() => setOpen(false)}
            className={cn(
              ITEM,
              'text-graphite no-underline hover:bg-g8 hover:text-graphite hover:no-underline',
            )}
          >
            <DownloadIcon />
            Download your mimic
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setConfirm(true);
            }}
            className={cn(ITEM, 'text-rust hover:bg-g8')}
          >
            <TrashIcon />
            Delete your mimic
          </button>
        </div>
      )}
      {confirm && <ConfirmDelete onCancel={() => setConfirm(false)} onDelete={onDelete} />}
    </div>
  );
}

function Divider() {
  return <div className="mx-1 my-1.5 h-px bg-rule" />;
}

function ConfirmDelete({ onCancel, onDelete }: { onCancel: () => void; onDelete: () => Promise<void> }) {
  return (
    <ConfirmDialog
      title="Delete your mimic?"
      body="This removes your answers, predictions, facts, snapshots and logs from every store. It can't be undone."
      confirmLabel="Delete"
      busyLabel="Deleting…"
      tone="rust"
      errorFallback="Could not delete."
      onCancel={onCancel}
      onConfirm={onDelete}
    />
  );
}
