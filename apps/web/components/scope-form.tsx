'use client';
import {
  AREA_INFO,
  CATEGORIES,
  CATEGORY_INFO,
  type MimicScope,
  SELF_ONLY_NOTE,
  SPECIAL_AREAS,
} from '@mimic/core/scope';
import { setCategory, setConsent, setResearch } from '@/lib/scope-form';
import { Checkbox, cn } from './ui';

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
  return (
    <fieldset className="space-y-5">
      <legend className="text-[15px] font-medium text-graphite">What to ask about</legend>
      <p className="-mt-2 text-[13px] text-muted">
        Turn off anything you&apos;d rather not share.{intake ? ' All topics are enabled by default.' : null}
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
                  <Checkbox
                    key={a}
                    id={`${idPrefix}-${a}`}
                    checked={!!value.consents[a]}
                    disabled={!on}
                    {...(!on ? { describedBy: lockId } : {})}
                    onChange={(v) => onChange(setConsent(value, a, v))}
                    label={`Ask about ${AREA_INFO[a].name.toLowerCase()}`}
                    hint={AREA_INFO[a].why}
                  />
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

/**
 * Research use of sensitive answers: shown only with research consent overall. Answers about politics, religion,
 * sexuality and health stay out of research unless each is ticked here; money follows the overall choice.
 */
export function ScopeResearch({
  value,
  onChange,
  idPrefix = 'scope',
  className,
}: {
  value: MimicScope;
  onChange: (next: MimicScope) => void;
  idPrefix?: string;
  className?: string;
}) {
  const areas = SPECIAL_AREAS.filter((a) => value.consents[a]);
  if (!areas.length && !value.consents.money) return null;
  return (
    <fieldset className={cn('space-y-3', className)}>
      <legend className="text-[15px] font-medium text-graphite">Research use of sensitive answers</legend>
      <p className="-mt-1 text-[13px] text-muted">
        Answers on these topics are left out of research unless you include them here.
      </p>
      {areas.map((a) => (
        <Checkbox
          key={a}
          id={`${idPrefix}-research-${a}`}
          checked={!!value.researchConsents[a]}
          onChange={(v) => onChange(setResearch(value, a, v))}
          label={`Include my answers about ${AREA_INFO[a].name.toLowerCase()}`}
        />
      ))}
      {value.consents.money && (
        <p className="text-[13px] text-muted">Money in detail follows your research choice above.</p>
      )}
    </fieldset>
  );
}
