'use client';
import type { ScopeChange } from '@mimic/core';
import type { MimicScope } from '@mimic/core/scope';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { allowDeclined, canSave, narrows, sameScope } from '@/lib/scope-form';
import { ScopeResearch, ScopeTopics } from '../scope-form';
import { cn } from '../ui';

/**
 * Topics and consent, from the session menu (ADR-0043). The change applies to the next question. Narrowing hides
 * what was learned in the withdrawn topics from then on and discards questions waiting in them; widening changes
 * nothing already stored. Focus moves into the dialog on open and back to the menu button on close; Escape cancels.
 */
export function TopicsDialog({
  mimicId,
  scope,
  consentResearch,
  declined = [],
  onClose,
  onSaved,
}: {
  mimicId: string;
  scope: MimicScope;
  consentResearch: boolean;
  /** Facets the person chose not to answer, with their names (ADR-0050). */
  declined?: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (change: ScopeChange) => void;
}) {
  const [draft, setDraft] = useState<MimicScope>(scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const id = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('input:not(:disabled)')?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busyRef.current && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const unchanged = sameScope(scope, draft);
  const narrowing = narrows(scope, draft);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setScope(mimicId, draft));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your topics could not be saved. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-g8 sm:items-center sm:p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[16px] bg-sheet shadow-pop sm:rounded-[12px]"
      >
        <div className="flex-none px-6 pt-6 pb-2">
          <h2 id={`${id}-title`} className="m-0 font-serif text-[24px] font-medium leading-8 text-graphite">
            Topics and consent
          </h2>
          <p className="mt-1 text-[14px] leading-5 text-slate">Changes apply from your next question.</p>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-4">
          <ScopeTopics value={draft} onChange={setDraft} idPrefix="topics" />
          {consentResearch && <ScopeResearch value={draft} onChange={setDraft} idPrefix="topics" />}
          {declined.some((f) => draft.declined?.includes(f.id)) && (
            <section aria-labelledby={`${id}-declined`} className="space-y-2">
              <h3 id={`${id}-declined`} className="m-0 text-[15px] font-medium text-graphite">
                You chose not to answer
              </h3>
              <p className="m-0 text-[13px] text-muted">
                We won&apos;t ask about these again unless you say so.
              </p>
              <ul className="m-0 list-none space-y-1 p-0">
                {declined
                  .filter((f) => draft.declined?.includes(f.id))
                  .map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center justify-between gap-3 text-[14px] text-graphite"
                    >
                      <span>{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setDraft(allowDeclined(draft, f.id))}
                        className="h-8 rounded-[6px] px-2 text-[13px] font-medium text-graphite underline underline-offset-2 hover:bg-g8"
                      >
                        Ask again
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>
        <div className="flex-none space-y-3 border-t border-rule px-6 py-4">
          {narrowing && (
            <p className="m-0 text-[13px] leading-5 text-slate">
              What you&apos;ve answered on topics you turn off will be hidden from your mimic from now on.
              Delete your mimic to remove it completely.
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-[14px] leading-5 text-rust">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-10 rounded-[8px] px-4 text-[14px] font-medium text-graphite hover:bg-g8 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || unchanged || !canSave(draft)}
              className={cn(
                'h-10 rounded-[8px] bg-graphite px-4 text-[14px] font-medium text-fog',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
