'use client';
import {
  AREA_INFO,
  CATEGORIES,
  CATEGORY_INFO,
  type MimicScope,
  SELF_ONLY_NOTE,
  type SpecialArea,
} from '@mimic/core/scope';
import { confirmArea, setCategory, setConsent, unconfirmed } from '@/lib/scope-form';
import { Checkbox } from './ui';

/**
 * "What to ask about" (ADR-0040, ADR-0043): the four categories, each sensitive area nested under its category with
 * its own consent, one line on why we ask and the self-only note. A sensitive area can only be chosen while its
 * category is on, and the last category on can't be turned off.
 */
export function ScopeTopics({
  value,
  onChange,
  idPrefix = 'scope',
  intake = false,
}: {
  value: MimicScope;
  onChange: (next: MimicScope) => void;
  idPrefix?: string;
  /** Intake starts from `INTAKE_SCOPE` (ADR-0049) and says so; the session dialog shows the person's own choices. */
  intake?: boolean;
}) {
  const last = value.categories.length === 1;
  const lastId = `${idPrefix}-last`;
  const pending = new Set<string>(unconfirmed(value));
  return (
    <fieldset className="space-y-5">
      <legend className="text-[15px] font-medium text-graphite">What to ask about</legend>
      <p className="-mt-2 text-[13px] text-muted">
        Turn off anything you&apos;d rather not share.{intake ? ' All topics are enabled by default.' : null}
        {intake
          ? " We'll check with you again before asking about political views, religion, sexuality or health."
          : null}
      </p>
      {CATEGORIES.map((c) => {
        const info = CATEGORY_INFO[c];
        const on = value.categories.includes(c);
        const lockId = `${idPrefix}-${c}-lock`;
        const onlyOne = on && last;
        return (
          <div key={c} className="space-y-3">
            <Checkbox
              id={`${idPrefix}-${c}`}
              checked={on}
              disabled={onlyOne}
              {...(onlyOne ? { describedBy: lastId } : {})}
              onChange={(v) => onChange(setCategory(value, c, v))}
              label={info.name}
              hint={info.description}
            />
            {info.areas.length > 0 && (
              <div className="ml-[30px] space-y-3 border-l border-line pl-4">
                {!on && (
                  <p id={lockId} className="pl-[30px] text-[13px] text-muted">
                    Turn on {info.name.toLowerCase()} to choose these.
                  </p>
                )}
                {info.areas.map((a) => (
                  <div key={a} className="space-y-2">
                    <Checkbox
                      id={`${idPrefix}-${a}`}
                      checked={!!value.consents[a]}
                      disabled={!on}
                      {...(!on ? { describedBy: lockId } : {})}
                      onChange={(v) => onChange(setConsent(value, a, v))}
                      label={`Ask about ${AREA_INFO[a].name.toLowerCase()}`}
                      hint={AREA_INFO[a].why}
                    />
                    {/* Left on at intake but never chosen (ADR-0050): not asked about until confirmed. */}
                    {!intake && on && pending.has(a) && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[30px] text-[13px] text-muted">
                        <span id={`${idPrefix}-${a}-pending`}>
                          Not confirmed yet, so we won&apos;t ask about it.
                        </span>
                        <button
                          type="button"
                          aria-describedby={`${idPrefix}-${a}-pending`}
                          onClick={() => onChange(confirmArea(value, a as SpecialArea, true))}
                          className="h-8 rounded-[6px] px-2 font-medium text-graphite underline underline-offset-2 hover:bg-g8"
                        >
                          Confirm
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                <p className="pl-[30px] text-[13px] text-muted">{SELF_ONLY_NOTE}</p>
              </div>
            )}
          </div>
        );
      })}
      {last && (
        <p id={lastId} className="text-[13px] text-muted">
          Keep at least one topic on.
        </p>
      )}
    </fieldset>
  );
}
