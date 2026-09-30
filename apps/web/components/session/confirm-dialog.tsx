'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../ui';

export interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  /** Rust for what can't be undone; graphite otherwise. */
  tone: 'rust' | 'graphite';
  /** Shown if `onConfirm` throws something without a message. */
  errorFallback: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * A modal yes/no (design: Delete confirm). Cancel has focus first; Escape cancels. While the confirmed action runs,
 * neither can close the dialog: the request would still land after it closed.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busyLabel,
  tone,
  errorFallback,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const id = useId();
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busyRef.current && onCancel();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-g8 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className="flex w-full max-w-[400px] flex-col gap-4 rounded-[12px] bg-sheet p-6 shadow-pop"
      >
        <h2 id={`${id}-title`} className="m-0 font-serif text-[24px] font-medium leading-8 text-graphite">
          {title}
        </h2>
        <div id={`${id}-body`} className="text-[14px] leading-5 text-slate [text-wrap:pretty]">
          {body}
        </div>
        {error && (
          <p role="alert" className="m-0 text-[14px] leading-5 text-rust">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-11 rounded-[8px] border border-rule bg-sheet px-4 text-[16px] font-medium text-graphite hover:border-slate disabled:opacity-60 disabled:hover:border-rule"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(e instanceof Error && e.message ? e.message : errorFallback);
                setBusy(false);
              }
            }}
            className={cn(
              'h-11 rounded-[8px] px-4 text-[16px] font-medium text-fog disabled:opacity-60',
              tone === 'rust' ? 'bg-rust' : 'bg-graphite',
            )}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
