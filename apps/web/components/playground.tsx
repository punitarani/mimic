'use client';
import type { Distribution, PlaygroundItem, PublicQuestion, UiSnapshot } from '@mimic/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CrossIcon, MinusIcon } from '@/components/session/icons';
import { Kbd } from '@/components/session/next-button';
import { OptionButton } from '@/components/session/option-button';
import { ScaleControl } from '@/components/session/scale-control';
import { Button, Card, Checkbox, cn, ErrorText, Input, Spinner, Textarea } from '@/components/ui';
import { api, type Draft } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/outbox';
import { pct, type Verdict, verdictOf } from '@/lib/session-view';

/** Mirrors the server's gate (MAX_PROMPT_WORDS, 2–5 choices); the server re-validates. */
const MAX_WORDS = 40;
const CHOICE_KEYS = ['a', 'b', 'c', 'd', 'e'];
const YES_NO: Draft['options'] = [
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' },
];
const BLANK: Draft = {
  type: 'choice',
  prompt: '',
  options: [
    { key: 'a', label: '' },
    { key: 'b', label: '' },
  ],
};

/** An asked question: the mimic's sealed guess, and the person's answer once they give it. */
interface Asked {
  question: PublicQuestion;
  dist: Distribution;
  guess: { optionKey: string; label: string; p: number };
  rationale: string | null;
  answer: string | null;
}

type Stage =
  | { name: 'compose' }
  | { name: 'edit' }
  | { name: 'teach'; picked: string | null; key: string }
  | { name: 'taught'; question: PublicQuestion; answer: string }
  | { name: 'asked'; asked: Asked; key: string };

function draftProblem(d: Draft): string | null {
  const prompt = d.prompt.trim();
  if (prompt.length < 8) return 'Write the question.';
  if (prompt.split(/\s+/).length > MAX_WORDS) return `Keep the question under ${MAX_WORDS} words.`;
  const labels = d.options.map((o) => o.label.trim().toLowerCase());
  if (labels.some((l) => !l)) return 'Fill in every option.';
  if (new Set(labels).size !== labels.length) return 'Two options say the same thing.';
  return null;
}

/**
 * PLAN §9.11 and ADR-0027: a scenario (or a question written by hand) becomes an editable typed question. The person
 * then either asks the mimic, sees its guess and checks it with their own answer (`playground`, scored separately),
 * or answers it themselves so the mimic learns from it (`feedback`, never scored).
 */
export function Playground({ id, snap }: { id: string; snap: UiSnapshot | undefined }) {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ['playground', id], queryFn: () => api.playground(id) });
  const [scenario, setScenario] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [withRationale, setWithRationale] = useState(false);
  const [stage, setStage] = useState<Stage>({ name: 'compose' });
  const [why, setWhy] = useState('');
  const [whyOpen, setWhyOpen] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'predict' | 'answer' | 'teach' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const outOfBudget = !!snap && snap.mimic.spendUsd >= snap.mimic.budgetUsd;

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const go = useCallback((next: Stage) => {
    setError(null);
    setStage(next);
    if (next.name !== 'teach') {
      setWhy('');
      setWhyOpen(false);
    }
  }, []);

  // Each new card takes focus (for keyboard and screen-reader users) and scrolls into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the card changes, not on picks
  useEffect(() => {
    if (stage.name === 'compose' || stage.name === 'edit') return;
    focusRef.current?.focus({ preventScroll: true });
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sectionRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [stage.name, stage.name === 'asked' ? stage.asked.question.id : null]);

  /** Back to the scenario box: "Start over" keeps what was written, "another" clears it. */
  const reset = (clear = true) => {
    setDraft(null);
    if (clear) setScenario('');
    go({ name: 'compose' });
  };

  const refresh = () => void qc.invalidateQueries({ queryKey: ['playground', id] });

  const ask = async () => {
    if (!draft) return;
    const r = await run('predict', () => api.predict(id, { ...draft, rationale: withRationale }));
    if (!r) return;
    go({ name: 'asked', asked: { ...r, answer: null }, key: newIdempotencyKey() });
    refresh();
  };

  const answerAsked = async (value: string) => {
    if (stage.name !== 'asked' || stage.asked.answer !== null || busy) return;
    const { asked, key } = stage;
    const r = await run('answer', () =>
      api.answer(id, { questionId: asked.question.id, value, latencyMs: 0, idempotencyKey: key }),
    );
    if (!r) return;
    setStage({ name: 'asked', asked: { ...asked, answer: value }, key });
    refresh();
  };

  const teach = async () => {
    if (!draft || stage.name !== 'teach' || !stage.picked || busy) return;
    const { picked, key } = stage;
    const reason = why.trim();
    const r = await run('teach', () =>
      api.teach(id, {
        question: draft,
        answer: picked,
        idempotencyKey: key,
        ...(reason ? { why: reason } : {}),
      }),
    );
    if (!r) return;
    go({ name: 'taught', question: r.question, answer: r.answer.optionKey });
    refresh();
    void qc.invalidateQueries({ queryKey: ['snapshot', id] });
  };

  const openItem = (it: PlaygroundItem) => {
    if (!it.guess || !it.dist) return;
    setDraft(null);
    go({
      name: 'asked',
      asked: {
        question: it.question,
        dist: it.dist,
        guess: it.guess,
        rationale: null,
        answer: it.answer?.optionKey ?? null,
      },
      key: newIdempotencyKey(),
    });
  };

  // The question being answered, as the person sees it (keys as drafted for teaching).
  const answering: Pick<PublicQuestion, 'type' | 'prompt' | 'options'> | null =
    stage.name === 'teach' ? draft : stage.name === 'asked' ? stage.asked.question : null;
  const canPick =
    !busy && (stage.name === 'teach' || (stage.name === 'asked' && stage.asked.answer === null));
  const onPick = (key: string) => {
    if (stage.name === 'teach') setStage({ ...stage, picked: key });
    else void answerAsked(key);
  };

  // Keyboard: 1–5 or Y/N pick, Enter saves a taught answer (PLAN §10.1).
  useEffect(() => {
    if (!answering || !canPick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'TEXTAREA' || t?.tagName === 'INPUT') return;
      if (e.key === 'Enter') {
        // A focused control keeps its own Enter, except the picked option, where Enter saves.
        const control = t?.closest('button, a');
        if (control && control.getAttribute('aria-checked') !== 'true') return;
        if (stage.name === 'teach' && stage.picked) {
          e.preventDefault();
          void teach();
        }
        return;
      }
      let key: string | undefined;
      if (answering.type === 'noul' && (e.key === 'y' || e.key === 'n')) key = e.key === 'y' ? 'yes' : 'no';
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= answering.options.length) key = answering.options[n - 1]!.key;
      if (key) {
        e.preventDefault();
        onPick(key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const problem = draft ? draftProblem(draft) : null;

  return (
    <section ref={sectionRef} aria-labelledby="pg-h" className="scroll-mt-4">
      <h2 id="pg-h" className="text-lg font-medium">
        Ask your mimic
      </h2>
      <p className="mt-1 text-[15px] text-muted">
        Describe a situation. See what your mimic predicts and check it, or tell it the right answer yourself.
      </p>

      {stage.name === 'compose' && (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run('draft', () => api.draft(id, scenario));
            if (r) {
              setDraft(r.draft);
              go({ name: 'edit' });
            }
          }}
        >
          <Textarea
            aria-label="Scenario"
            rows={3}
            maxLength={1000}
            placeholder="A recruiter offers a role at a fast-growing startup, with a pay cut but more equity…"
            value={scenario}
            disabled={outOfBudget}
            onChange={(e) => setScenario(e.target.value)}
          />
          {outOfBudget && (
            <p className="text-[14px] text-muted">
              Your mimic has used its budget, so it can't write or predict new questions. You can still write
              a question and answer it yourself.
            </p>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {!outOfBudget && (
              <Button type="submit" disabled={scenario.trim().length < 8 || busy !== null}>
                {busy === 'draft' ? 'Writing the question…' : 'Turn into a question'}
              </Button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setDraft({ ...BLANK, options: BLANK.options.map((o) => ({ ...o })) });
                go({ name: 'edit' });
              }}
              className="h-10 text-[15px] font-medium text-graphite-soft underline-offset-2 hover:text-graphite hover:underline"
            >
              Write the question yourself
            </button>
          </div>
        </form>
      )}

      {stage.name === 'edit' && draft && (
        <Card className="mt-4 space-y-5 p-4 sm:p-5">
          <DraftEditor draft={draft} onChange={setDraft} />
          {!outOfBudget && (
            <Checkbox
              id="pg-rationale"
              checked={withRationale}
              onChange={setWithRationale}
              label="When asking, also write one generated sentence explaining the guess"
            />
          )}
          <ErrorText>{error}</ErrorText>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {!outOfBudget && (
                <Button onClick={ask} disabled={busy !== null || problem !== null}>
                  {busy === 'predict' ? 'Predicting…' : 'Ask my mimic'}
                </Button>
              )}
              <Button
                variant={outOfBudget ? 'primary' : 'secondary'}
                disabled={busy !== null || problem !== null}
                onClick={() => go({ name: 'teach', picked: null, key: newIdempotencyKey() })}
              >
                Answer it myself
              </Button>
              <Button variant="ghost" onClick={() => reset(false)} disabled={busy !== null}>
                Start over
              </Button>
            </div>
            <p className="text-[13px] text-muted" aria-live="polite">
              {problem ??
                (outOfBudget
                  ? 'Your answer teaches your mimic.'
                  : 'Asking shows its guess, and your answer checks it. Answering yourself teaches it instead.')}
            </p>
          </div>
        </Card>
      )}

      {stage.name === 'teach' && draft && (
        <Card className="mt-4 space-y-5 p-4 sm:p-5">
          <div className="space-y-2">
            <p className="text-[14px] text-muted">Pick the right answer. Your mimic learns from it.</p>
            <h3 ref={focusRef} tabIndex={-1} className="prompt focus-target text-[1.35rem] leading-snug">
              {draft.prompt.trim()}
            </h3>
          </div>
          <Choices q={draft} picked={stage.picked} disabled={busy !== null} onPick={onPick} />
          {whyOpen && (
            <Textarea
              aria-label="Your reason (optional)"
              placeholder="Why? Optional. Your mimic reads it too."
              rows={2}
              maxLength={1000}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              autoFocus
            />
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={teach} disabled={!stage.picked || busy !== null}>
              {busy === 'teach' ? 'Saving…' : 'Teach my mimic'}
            </Button>
            <Button variant="ghost" onClick={() => go({ name: 'edit' })} disabled={busy !== null}>
              Edit question
            </Button>
            <button
              type="button"
              onClick={() => {
                if (whyOpen) setWhy('');
                setWhyOpen(!whyOpen);
              }}
              className="ml-auto h-10 text-[14px] font-medium text-slate hover:text-graphite"
            >
              {whyOpen ? 'Remove reason' : 'Add a reason (optional)'}
            </button>
          </div>
          <KeyHint type={draft.type} n={draft.options.length} enter={!!stage.picked} />
        </Card>
      )}

      {stage.name === 'taught' && (
        <Card className="mt-4 space-y-4 p-4 sm:p-5">
          <p role="status" className="animate-reveal flex items-start gap-2 text-[16px] leading-6 text-moss">
            <CheckIcon className="mt-0.5 flex-none" />
            <span>Saved. Your mimic will learn from this answer.</span>
          </p>
          <h3 ref={focusRef} tabIndex={-1} className="prompt focus-target text-[1.35rem] leading-snug">
            {stage.question.prompt}
          </h3>
          <Choices q={stage.question} picked={stage.answer} disabled onPick={() => {}} />
          <Button variant="secondary" onClick={() => reset()}>
            Ask or teach another
          </Button>
        </Card>
      )}

      {stage.name === 'asked' && (
        <Card className="mt-4 space-y-4 p-4 sm:p-5">
          <h3 ref={focusRef} tabIndex={-1} className="prompt focus-target text-[1.35rem] leading-snug">
            {stage.asked.question.prompt}
          </h3>
          <Choices
            q={stage.asked.question}
            picked={stage.asked.answer}
            dist={stage.asked.dist}
            guess={stage.asked.guess.optionKey}
            disabled={stage.asked.answer !== null || busy !== null}
            onPick={onPick}
          />
          <AskedStatus asked={stage.asked} busy={busy === 'answer'} />
          <ErrorText>{error}</ErrorText>
          {stage.asked.rationale && (
            <p className="rounded-[10px] bg-surface p-3 text-[14px]">
              <span className="mr-2 rounded-full border border-line px-1.5 text-[11px] uppercase tracking-wide text-muted">
                generated
              </span>
              {stage.asked.rationale}
            </p>
          )}
          {stage.asked.answer === null && (
            <KeyHint type={stage.asked.question.type} n={stage.asked.question.options.length} enter={false} />
          )}
          <Button variant="secondary" onClick={() => reset()} disabled={busy !== null}>
            Ask or teach another
          </Button>
        </Card>
      )}

      <History
        data={history.data}
        loading={history.isLoading}
        activeId={stage.name === 'asked' ? stage.asked.question.id : null}
        onOpen={openItem}
      />
    </section>
  );
}

function DraftEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  // Switching to yes/no and back keeps the options that were written.
  const stash = useRef<Draft['options'] | null>(null);
  const setType = (type: 'choice' | 'noul') => {
    if (type === draft.type) return;
    if (type === 'noul') {
      stash.current = draft.options;
      onChange({ ...draft, type, options: YES_NO });
    } else {
      onChange({ ...draft, type, options: stash.current ?? BLANK.options.map((o) => ({ ...o })) });
    }
  };
  const setLabel = (key: string, label: string) =>
    onChange({ ...draft, options: draft.options.map((o) => (o.key === key ? { ...o, label } : o)) });
  const add = () => {
    const key = CHOICE_KEYS.find((k) => !draft.options.some((o) => o.key === k));
    if (key) onChange({ ...draft, options: [...draft.options, { key, label: '' }] });
  };
  const remove = (key: string) => onChange({ ...draft, options: draft.options.filter((o) => o.key !== key) });

  return (
    <>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor="pg-prompt">
          Question
        </label>
        <Textarea
          id="pg-prompt"
          rows={2}
          maxLength={300}
          placeholder="Would you take the startup offer?"
          value={draft.prompt}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
        />
      </div>
      <fieldset className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <legend className="text-sm font-medium">Answers</legend>
          {draft.type !== 'score' && (
            <div
              role="radiogroup"
              aria-label="Answer type"
              className="flex rounded-[10px] border border-line p-0.5"
            >
              {(
                [
                  ['choice', 'Options'],
                  ['noul', 'Yes or no'],
                ] as const
              ).map(([t, label]) => (
                // biome-ignore lint/a11y/useSemanticElements: a two-way segmented control
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={draft.type === t}
                  onClick={() => setType(t)}
                  className={cn(
                    'h-8 rounded-[8px] px-3 text-[14px] font-medium',
                    draft.type === t ? 'bg-graphite text-fog' : 'text-graphite-soft hover:text-graphite',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {draft.type === 'score' && (
          <p className="text-[13px] text-muted">A scale from 1 to 5. Edit the label for each step.</p>
        )}
        <ul className="space-y-2">
          {draft.options.map((o, i) => (
            <li key={o.key} className="flex items-center gap-2">
              {draft.type === 'score' && (
                <span className="w-4 flex-none text-center text-[14px] text-muted tabular-nums">{i + 1}</span>
              )}
              <Input
                aria-label={draft.type === 'score' ? `Step ${i + 1} label` : `Option ${i + 1}`}
                placeholder={draft.type === 'choice' ? `Option ${i + 1}` : undefined}
                maxLength={160}
                value={o.label}
                disabled={draft.type === 'noul'}
                onChange={(e) => setLabel(o.key, e.target.value)}
              />
              {draft.type === 'choice' && draft.options.length > 2 && (
                <button
                  type="button"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => remove(o.key)}
                  className="grid size-10 flex-none place-items-center rounded-[10px] text-slate hover:bg-surface hover:text-graphite"
                >
                  <CrossIcon width={18} height={18} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {draft.type === 'choice' && draft.options.length < CHOICE_KEYS.length && (
          <button
            type="button"
            onClick={add}
            className="h-9 text-[14px] font-medium text-graphite-soft hover:text-graphite hover:underline"
          >
            Add an option
          </button>
        )}
      </fieldset>
    </>
  );
}

/** The answer controls, as in the session: option buttons or a 5-step scale, with the mimic's bars when shown. */
function Choices({
  q,
  picked,
  dist,
  guess,
  disabled,
  onPick,
}: {
  q: Pick<PublicQuestion, 'type' | 'prompt' | 'options'>;
  picked: string | null;
  dist?: Distribution;
  guess?: string;
  disabled: boolean;
  onPick: (key: string) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const keys = q.options.map((o) => o.key);
  // Arrow keys move between options (roving focus in the radiogroup).
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const dir =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const i = refs.current.indexOf(e.currentTarget);
    refs.current[(i + dir + keys.length) % keys.length]?.focus();
  };
  const tabIndexFor = (i: number) => (picked ? (keys[i] === picked ? 0 : -1) : i === 0 ? 0 : -1);

  if (q.type === 'score')
    return (
      <ScaleControl
        keys={keys}
        lo={q.options[0]!.label}
        hi={q.options.at(-1)!.label}
        picked={picked}
        dist={dist ?? null}
        disabled={disabled}
        onPick={onPick}
        onKeyDown={onKey}
        refFor={(i) => (el) => {
          refs.current[i] = el;
        }}
        tabIndexFor={tabIndexFor}
      />
    );
  return (
    <div
      role="radiogroup"
      aria-label={q.prompt}
      className={cn(q.type === 'noul' ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3')}
    >
      {q.options.map((o, i) => (
        <OptionButton
          key={o.key}
          ref={(el) => {
            refs.current[i] = el;
          }}
          label={o.label}
          hint={q.type === 'noul' ? (o.key === 'yes' ? 'Y' : 'N') : String(i + 1)}
          center={q.type === 'noul'}
          pct={dist ? Math.round((dist[o.key] ?? 0) * 100) : null}
          you={picked === o.key}
          mimic={guess === o.key}
          disabled={disabled}
          tabIndex={tabIndexFor(i)}
          onPick={() => onPick(o.key)}
          onKeyDown={onKey}
        />
      ))}
    </div>
  );
}

function AskedStatus({ asked, busy }: { asked: Asked; busy: boolean }) {
  if (busy)
    return (
      <p className="flex items-center gap-2 text-[15px] text-muted">
        <Spinner /> Saving your answer…
      </p>
    );
  if (asked.answer === null)
    return (
      <p className="text-[15px] leading-6 text-muted">
        Your mimic guessed “{asked.guess.label}” ({pct(asked.guess.p)}%). Which would you actually pick? Your
        answer checks the guess; it isn't used to teach your mimic.
      </p>
    );
  const v = verdictOf(asked.question, { ...asked.guess, dist: asked.dist }, asked.answer);
  return (
    <p
      role="status"
      className={cn('animate-reveal flex items-start gap-2 text-[16px] leading-6', TONE[v.tone])}
    >
      <VerdictIcon tone={v.tone} className="mt-0.5 flex-none" />
      <span>{v.text}</span>
    </p>
  );
}

const TONE: Record<Verdict['tone'], string> = { moss: 'text-moss', slate: 'text-slate', rust: 'text-rust' };

function VerdictIcon({ tone, className }: { tone: Verdict['tone']; className?: string }) {
  const Icon = tone === 'moss' ? CheckIcon : tone === 'rust' ? CrossIcon : MinusIcon;
  return <Icon className={className} />;
}

function KeyHint({ type, n, enter }: { type: PublicQuestion['type']; n: number; enter: boolean }) {
  return (
    <p className="hidden items-center gap-1.5 text-[14px] leading-5 text-slate lg:flex">
      <Kbd>{type === 'noul' ? 'Y / N' : `1–${n}`}</Kbd>
      <span>to pick{enter ? ',' : ''}</span>
      {enter && (
        <>
          <Kbd>Enter</Kbd>
          <span>to save</span>
        </>
      )}
    </p>
  );
}

function History({
  data,
  loading,
  activeId,
  onOpen,
}: {
  data: Awaited<ReturnType<typeof api.playground>> | undefined;
  loading: boolean;
  activeId: string | null;
  onOpen: (it: PlaygroundItem) => void;
}) {
  if (loading) return null;
  if (!data?.items.length) return null;
  const parts = [
    data.taught ? `You've taught it ${data.taught} ${data.taught === 1 ? 'answer' : 'answers'}.` : null,
    data.checked ? `It matched ${data.matched} of the ${data.checked} guesses you checked.` : null,
  ].filter(Boolean);
  return (
    <div className="mt-8 space-y-3">
      <div>
        <h3 className="text-[15px] font-medium">Your answers</h3>
        {parts.length > 0 && <p className="mt-0.5 text-[14px] text-muted">{parts.join(' ')}</p>}
      </div>
      <ul className="divide-y divide-line rounded-[12px] border border-line bg-raised">
        {data.items.map((it) => (
          <HistoryRow key={it.question.id} it={it} active={it.question.id === activeId} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}

function HistoryRow({
  it,
  active,
  onOpen,
}: {
  it: PlaygroundItem;
  active: boolean;
  onOpen: (it: PlaygroundItem) => void;
}) {
  const taught = it.question.kind === 'feedback';
  const p = it.guess ? pct(it.guess.p) : 0;
  const v =
    it.answer && it.guess && it.dist
      ? verdictOf(it.question, { ...it.guess, dist: it.dist }, it.answer.optionKey)
      : null;
  const open = !taught && !it.answer;
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', active && 'bg-surface')}>
      <span className="grid size-5 flex-none place-items-center" aria-hidden="true">
        {taught ? (
          <span className="block size-2.5 rounded-full bg-graphite" />
        ) : v ? (
          <VerdictIcon tone={v.tone} className={TONE[v.tone]} />
        ) : (
          <span className="block size-3.5 rounded-full border-2 border-dashed border-ink" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[15px] leading-snug text-graphite">{it.question.prompt}</p>
        <p className="mt-0.5 text-[13px] text-muted">
          {taught ? (
            <>
              Taught: <span className="text-graphite">{it.answer?.label}</span>
            </>
          ) : it.answer ? (
            <>
              You: <span className="text-graphite">{it.answer.label}</span> · Mimic:{' '}
              <span className="text-ink">{it.guess?.label}</span> ({p}%)
              {v && <span className="sr-only">. {v.text.split('.')[0]}.</span>}
            </>
          ) : (
            <>
              Mimic guessed <span className="text-ink">{it.guess?.label}</span> ({p}%). Not answered yet.
            </>
          )}
        </p>
      </div>
      {open && !active && (
        <Button variant="secondary" size="sm" className="flex-none" onClick={() => onOpen(it)}>
          Answer
        </Button>
      )}
    </li>
  );
}
