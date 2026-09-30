'use client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../ui';

/** Mobile bottom sheet (design M4): opens at 50%, the handle expands it; overlay graphite/8. */
export function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setFull(false);
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <button
        type="button"
        aria-label="Close your mimic"
        tabIndex={-1}
        className="absolute inset-0 bg-g8"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your mimic"
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[16px] bg-sheet shadow-pop transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          full ? 'h-[92dvh]' : 'h-[50dvh]',
        )}
      >
        <div className="relative flex h-11 flex-none justify-center pt-2">
          <button
            type="button"
            aria-label={full ? 'Shrink' : 'Expand'}
            onClick={() => setFull(!full)}
            className="flex h-6 w-16 justify-center pt-0"
          >
            <span className="h-1 w-9 rounded-full bg-rule" />
          </button>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            className="absolute top-1 right-3 h-9 px-2 text-[14px] font-medium leading-5 text-graphite"
          >
            Close
          </button>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
