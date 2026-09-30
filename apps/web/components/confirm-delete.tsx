'use client';
import { ConfirmDialog } from './session/confirm-dialog';

/** The hard-delete confirmation (PLAN §15), shared by the session menu and the mimic page. */
export function ConfirmDelete({
  onCancel,
  onDelete,
}: {
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
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
