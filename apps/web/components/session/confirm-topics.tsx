'use client';
import type { ScopeChange } from '@mimic/core';
import { AREA_INFO, type MimicScope, SELF_ONLY_NOTE, type SpecialArea } from '@mimic/core/scope';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { confirmArea } from '@/lib/scope-form';
import { cn } from '../ui';

/**
 * The check before sensitive questions (ADR-0050). Intake leaves every area ticked (ADR-0049), and a box left ticked
 * is not a choice, so politics, religion, sexuality and health are only asked about once the person says so here, in
 * the session, once the first questions are behind them. Each area needs its own answer; "Not now" leaves them all
 * unasked for this visit.
 */
export function ConfirmTopics({
  mimicId,
  scope,
  areas,
  onSaved,
  onLater,
}: {
  mimicId: string;
  scope: MimicScope;
  areas: SpecialArea[];
  onSaved: (change: ScopeChange) => void;
  onLater: () => void;
}) {
  const [choice, setChoice] = useState<Partial<Record<SpecialArea, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => heading.current?.focus(), []);

  const decided = areas.every((a) => choice[a] !== undefined);

  async function save() {
    setBusy(true);
    setError(null);
    let next = scope;
    for (const a of areas) next = confirmArea(next, a, choice[a] === true);
    try {
      onSaved(await api.setScope(mimicId, next));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your answer could not be saved. Try again.');
      setBusy(false);
    }
  }

  return (
    <section data-confirm-topics aria-labelledby={`${id}-title`} className="flex flex-col gap-5">
      <div className="space-y-2">
        <h1
          ref={heading}
          id={`${id}-title`}
          tabIndex={-1}
          className="m-0 font-serif text-[26px] font-normal leading-[34px] text-graphite lg:text-[32px] lg:leading-[40px]"
        >
          Before we ask about sensitive topics
        </h1>
        <p className="m-0 text-[16px] leading-6 text-slate">
          These were on when you started. Tell us which ones we may ask about. You can change this any time in
          Topics and consent.
        </p>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {areas.map((a) => (
          <li key={a}>
            <fieldset className="m-0 rounded-[10px] border border-rule bg-sheet px-4 py-3">
              <legend className="float-left m-0 w-full p-0 text-[16px] font-medium leading-6 text-graphite">
                {AREA_INFO[a].name}
              </legend>
              <p className="clear-both m-0 pt-1 text-[13px] leading-5 text-muted">{AREA_INFO[a].why}</p>
              <div className="mt-3 flex gap-2">
                {[
                  { yes: true, label: 'Ask me' },
                  { yes: false, label: "Don't ask" },
                ].map(({ yes, label }) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={choice[a] === yes}
                    onClick={() => setChoice({ ...choice, [a]: yes })}
                    disabled={busy}
                    className={cn(
                      'h-10 rounded-[8px] border px-4 text-[14px] font-medium',
                      choice[a] === yes
                        ? 'border-graphite bg-graphite text-fog'
                        : 'border-rule bg-fog text-graphite hover:border-graphite',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[13px] text-muted">{SELF_ONLY_NOTE}</p>
      {error && (
        <p role="alert" className="m-0 text-[14px] leading-5 text-rust">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onLater}
          disabled={busy}
          className="h-10 rounded-[8px] px-4 text-[14px] font-medium text-graphite hover:bg-g8 disabled:opacity-50"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !decided}
          className="h-10 rounded-[8px] bg-graphite px-4 text-[14px] font-medium text-fog disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </section>
  );
}
