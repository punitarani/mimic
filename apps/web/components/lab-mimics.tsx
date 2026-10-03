'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ConfirmDialog } from './session/confirm-dialog';
import { cn } from './ui';

const LINK =
  'whitespace-nowrap rounded-[6px] px-1.5 py-0.5 text-[13px] text-rust hover:bg-rust/10 focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * Hard-deletes one mimic from /lab/mimics (ADR-0076), after a confirmation. With `redirectTo` it leaves the page it
 * deleted, replacing it in the history so Back doesn't return to it; otherwise it refreshes the list in place.
 */
export function DeleteMimicButton({
  id,
  name,
  redirectTo,
  className,
}: {
  id: string;
  name: string;
  redirectTo?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`Delete ${name}`}
        className={cn(LINK, className)}
        onClick={() => setOpen(true)}
      >
        Delete
      </button>
      {open && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          body="This removes the mimic's answers, predictions, facts, snapshots and logs from every store. It can't be undone."
          confirmLabel="Delete mimic"
          busyLabel="Deleting…"
          tone="rust"
          errorFallback="Could not delete."
          onCancel={() => setOpen(false)}
          onConfirm={async () => {
            await api.labDeleteMimic(id);
            setOpen(false);
            if (redirectTo) router.replace(redirectTo);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/** Hard-deletes a person: every mimic they own, then their participant row (ADR-0076). */
export function DeletePersonButton({
  participantId,
  mimics,
  redirectTo,
  className,
}: {
  participantId: string;
  mimics: number;
  redirectTo?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`Delete person ${participantId}`}
        className={cn(LINK, className)}
        onClick={() => setOpen(true)}
      >
        Delete person
      </button>
      {open && (
        <ConfirmDialog
          title="Delete this person?"
          body={
            <>
              This deletes{' '}
              <strong className="font-medium text-graphite">
                {mimics === 1 ? 'their mimic' : `all ${mimics} of their mimics`}
              </strong>{' '}
              (answers, predictions, facts, snapshots and logs, from every store) and their participant
              record. It can't be undone.
            </>
          }
          confirmLabel="Delete person"
          busyLabel="Deleting…"
          tone="rust"
          errorFallback="Could not delete."
          onCancel={() => setOpen(false)}
          onConfirm={async () => {
            await api.labDeleteParticipant(participantId);
            setOpen(false);
            if (redirectTo) router.replace(redirectTo);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
