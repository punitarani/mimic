'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * The hard-delete confirmation (PLAN §15), shared by the session menu and the mimic page. Focus moves to Cancel on
 * open and back to whatever opened it on close; Escape cancels. While the delete is in flight nothing can cancel it,
 * because it would still finish.
 */
export function ConfirmDelete({
  onCancel,
  onDelete,
}: {
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
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
        aria-labelledby="delete-title"
        aria-describedby="delete-body"
        className="flex w-full max-w-[400px] flex-col gap-4 rounded-[12px] bg-sheet p-6 shadow-pop"
      >
        <h2 id="delete-title" className="m-0 font-serif text-[24px] font-medium leading-8 text-graphite">
          Delete your mimic?
        </h2>
        <p id="delete-body" className="m-0 text-[14px] leading-5 text-slate [text-wrap:pretty]">
          This removes your answers, predictions, facts, snapshots and logs from every store. It can't be
          undone.
        </p>
        {error && (
          <p role="alert" className="m-0 text-[14px] leading-5 text-rust">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-11 rounded-[8px] border border-rule bg-sheet px-4 text-[16px] font-medium text-graphite hover:border-slate disabled:cursor-not-allowed disabled:opacity-60"
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
                await onDelete();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not delete.');
                setBusy(false);
              }
            }}
            className="h-11 rounded-[8px] bg-rust px-4 text-[16px] font-medium text-fog disabled:opacity-60"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
