'use client';
import type { NextResult, PublicQuestion, Reveal, UiSnapshot } from '@mimic/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BottomSheet } from '@/components/session/bottom-sheet';
import { CheckIcon, CrossIcon, MinusIcon } from '@/components/session/icons';
import { ModelPanel } from '@/components/session/model-panel';
import { Kbd, NextButton } from '@/components/session/next-button';
import { OptionButton } from '@/components/session/option-button';
import { OverlapMark } from '@/components/session/overlap-mark';
import { ScaleControl } from '@/components/session/scale-control';
import { SessionMenu } from '@/components/session/session-menu';
import { cn, Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { enqueueAnswer, flushOutbox, newIdempotencyKey, pendingAnswers, sendAnswer } from '@/lib/outbox';
import { changeFromHistory, pct, verdictOf, whatChanged } from '@/lib/session-view';

type Progress = NextResult['progress'];

/** Learning runs in the background after an answer; the panel re-reads the snapshot on this schedule. */
const SNAPSHOT_REFRESH_MS = [0, 2500, 6000, 12000];
const UPDATED_MS = 4000;

function useGuesses(mimicId: string): [boolean, (on: boolean) => void] {
  const key = `mimic-guesses:${mimicId}`;
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      setOn(localStorage.getItem(key) !== 'off');
    } catch {
      /* default: shown */
    }
  }, [key]);
  const set = useCallback(
    (v: boolean) => {
      setOn(v);
      try {
        localStorage.setItem(key, v ? 'on' : 'off');
      } catch {
        /* this page only */
      }
    },
    [key],
  );
  return [on, set];
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState<{ question: PublicQuestion; progress: Progress } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [answered, setAnswered] = useState(false);
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonSent, setReasonSent] = useState(false);
  const [firstOfVisit, setFirstOfVisit] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<{
    label: string;
    match: boolean | null;
    baseline: UiSnapshot;
  } | null>(null);
  const [guesses, setGuesses] = useGuesses(id);
  const done = useRef(new Set<string>());
  const shownAt = useRef(Date.now());
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const nextRef = useRef<HTMLButtonElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const snap = useQuery({ queryKey: ['snapshot', id], queryFn: () => api.snapshot(id) });
  const identity = useQuery({ queryKey: ['identity', id], queryFn: () => api.identity(id) });
  // POST /next is idempotent per seq, so it is safe as a query; the result is persisted for instant restore.
  const next = useQuery({
    queryKey: ['question', id],
    queryFn: () => api.next(id),
    enabled: ready,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 1500 : false),
  });

  // On load: send anything left in the outbox first, so a cached question that was already answered isn't shown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pending = await pendingAnswers(id);
      if (pending.length) {
        await flushOutbox(id);
        if ((await pendingAnswers(id)).length) setOffline(true);
        await qc.invalidateQueries({ queryKey: ['question', id] });
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, qc]);

  useEffect(() => {
    const on = () => {
      void flushOutbox(id).then(async () => {
        if (!(await pendingAnswers(id)).length) {
          setOffline(false);
          void qc.invalidateQueries({ queryKey: ['snapshot', id] });
        }
      });
    };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [id, qc]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const data: NextResult | undefined = next.data;

  // The question on screen stays until Next, even after the next one is prefetched.
  useEffect(() => {
    if (answered || sending || data?.status !== 'question') return;
    if (done.current.has(data.question.id) || data.question.id === current?.question.id) return;
    setCurrent({ question: data.question, progress: data.progress });
    shownAt.current = Date.now();
  }, [data, answered, sending, current?.question.id]);

  useEffect(() => {
    if (data?.status === 'identity') router.replace(`/m/${id}/identity`);
  }, [data?.status, id, router]);

  const s = snap.data;
  const revealConfigured = s ? s.mimic.reveal === 'after_answer' : true;
  const showGuesses = revealConfigured && guesses;

  const pick = useCallback(
    async (value: string) => {
      if (!current || answered || sending || offline) return;
      const q = current.question;
      setPicked(value);
      setSending(true);
      setError(null);
      const why = reasonOpen ? reason.trim() : '';
      const item = {
        mimicId: id,
        questionId: q.id,
        value,
        latencyMs: Math.min(3_600_000, Date.now() - shownAt.current),
        idempotencyKey: newIdempotencyKey(),
        createdAt: Date.now(),
        ...(why ? { why } : {}),
        ...(revealConfigured ? { revealShown: showGuesses } : {}),
      };
      const baseline = qc.getQueryData<UiSnapshot>(['snapshot', id]);
      const label = q.options.find((o) => o.key === value)?.label ?? value;
      await enqueueAnswer(item); // durable before the network
      try {
        const res = await sendAnswer(item);
        done.current.add(q.id);
        setReveal(res.reveal);
        setAnswered(true);
        setReasonSent(!!why);
        if (baseline) setLastAnswer({ label, match: res.reveal ? res.reveal.match : null, baseline });
        // Prefetch the next question while the reveal shows; no auto-advance.
        void qc
          .fetchQuery({ queryKey: ['question', id], queryFn: () => api.next(id), staleTime: 0 })
          .catch(() => null);
        timers.current.forEach(clearTimeout);
        timers.current = SNAPSHOT_REFRESH_MS.map((ms) =>
          setTimeout(() => void qc.invalidateQueries({ queryKey: ['snapshot', id] }), ms),
        );
      } catch (e) {
        if (e instanceof ApiError && e.status < 500 && e.status !== 429) {
          setError(e.message);
          setPicked(null);
          done.current.add(q.id);
          void qc.invalidateQueries({ queryKey: ['question', id] });
          setCurrent(null);
        } else {
          // Kept in the outbox and retried on reconnect.
          done.current.add(q.id);
          setAnswered(true);
          setOffline(true);
        }
      } finally {
        setSending(false);
      }
    },
    [current, answered, sending, offline, reasonOpen, reason, id, revealConfigured, showGuesses, qc],
  );

  const advance = useCallback(() => {
    if (!answered || offline) return;
    setAnswered(false);
    setPicked(null);
    setReveal(null);
    setReason('');
    setReasonOpen(false);
    setReasonSent(false);
    setFirstOfVisit(false);
    const d = qc.getQueryData<NextResult>(['question', id]);
    if (d?.status === 'question' && !done.current.has(d.question.id)) {
      setCurrent({ question: d.question, progress: d.progress });
      shownAt.current = Date.now();
    } else {
      setCurrent(null);
      // The prefetch may still be in flight; only ask again if it isn't.
      if (qc.getQueryState(['question', id])?.fetchStatus !== 'fetching')
        void qc.invalidateQueries({ queryKey: ['question', id] });
    }
  }, [answered, offline, qc, id]);

  // Move focus to Next once the answer is in, so Enter and screen readers land there.
  useEffect(() => {
    if (answered && !offline) nextRef.current?.focus({ preventScroll: true });
  }, [answered, offline]);

  const q = current?.question ?? null;
  const optionKeys = q ? q.options.map((o) => o.key) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
      if (e.key === 'Enter' && !typing) {
        if (answered) {
          e.preventDefault();
          advance();
        }
        return;
      }
      if (typing || !q || answered) return;
      if (q.type === 'noul' && (e.key === 'y' || e.key === 'n')) {
        void pick(e.key === 'y' ? 'yes' : 'no');
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
        void pick(q.options[n - 1]!.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [q, answered, advance, pick]);

  // Arrow keys move between options (roving focus in the radiogroup).
  const onOptionKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const dir =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const i = optionRefs.current.indexOf(e.currentTarget);
    const len = optionKeys.length;
    optionRefs.current[(i + dir + len) % len]?.focus();
  };
  const tabIndexFor = (i: number) => (picked ? (optionKeys[i] === picked ? 0 : -1) : i === 0 ? 0 : -1);

  const change = useMemo(
    () => (s ? (lastAnswer ? whatChanged(lastAnswer.baseline, s, lastAnswer) : changeFromHistory(s)) : null),
    [lastAnswer, s],
  );
  // Facets that just moved show "Updated" and their previous position for a few seconds.
  const [moved, setMoved] = useState<Map<string, number>>(new Map());
  const movedKey = change ? [...change.moved].map(([k, v]) => `${k}:${v.toFixed(3)}`).join('|') : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the moved set, not the change object
  useEffect(() => {
    if (!change?.moved.size) return;
    setMoved(new Map(change.moved));
    const t = setTimeout(() => setMoved(new Map()), UPDATED_MS);
    return () => clearTimeout(t);
  }, [movedKey]);

  const onFact = useCallback(
    async (factId: string, userState: 'active' | 'removed') => {
      await api.setFact(id, factId, userState).catch(() => null);
      void qc.invalidateQueries({ queryKey: ['identity', id] });
      void qc.invalidateQueries({ queryKey: ['snapshot', id] });
    },
    [id, qc],
  );

  async function finish() {
    await api.stop(id).catch(() => null);
    router.push(`/m/${id}/mimic`);
  }

  async function remove() {
    await api.remove(id);
    qc.removeQueries({ queryKey: ['snapshot', id] });
    qc.removeQueries({ queryKey: ['question', id] });
    router.push('/');
  }

  const progress = current?.progress ?? data?.progress ?? s?.progress;
  const target = progress?.target ?? 30;
  const answeredCount = progress?.answered ?? 0;
  const counter = progress ? `${answeredCount + 1} of ~${target}` : '';
  const f = s?.fidelity;
  const calibrating = !s || s.progress.answered < s.progress.basics || !f;

  const panel = (lead: boolean) =>
    s ? (
      <ModelPanel
        snap={s}
        facts={identity.data?.facts}
        change={change}
        moved={moved}
        lead={lead}
        onFact={onFact}
        className={lead ? 'px-5' : 'px-8'}
      />
    ) : (
      <div className="px-8 py-6">
        <Spinner />
      </div>
    );

  const menu = (compact: boolean) => (
    <SessionMenu
      mimicId={id}
      compact={compact}
      guesses={revealConfigured ? guesses : null}
      onGuesses={setGuesses}
      onDelete={remove}
      {...(compact ? { onFinish: finish } : {})}
    />
  );

  return (
    <div className="relative flex h-dvh overflow-hidden bg-fog">
      {/* Desktop: the model panel (design D1–D7). */}
      <aside
        aria-label="Your mimic"
        className="hidden w-[400px] flex-none flex-col bg-sheet lg:flex xl:w-[480px]"
      >
        <div className="flex h-14 flex-none items-center px-8">
          <Link
            href="/"
            className="font-serif text-[20px] font-medium leading-7 text-graphite no-underline hover:no-underline"
          >
            Mimic
          </Link>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">{panel(false)}</div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* Desktop top bar */}
        <div className="hidden h-14 flex-none items-center justify-end gap-4 pr-6 pl-8 lg:flex">
          <span className="text-[14px] leading-5 text-slate tabular-nums">{counter}</span>
          <button
            type="button"
            onClick={finish}
            className="h-9 px-2 text-[14px] font-medium leading-5 text-graphite hover:underline"
          >
            Finish for now
          </button>
          {menu(false)}
        </div>
        {/* Mobile top bar (design M1–M4): Finish for now lives in the menu. */}
        <div className="flex h-14 flex-none items-center gap-2 pr-2 pl-4 lg:hidden">
          <span className="flex-1 font-serif text-[20px] font-medium leading-7 text-graphite">Mimic</span>
          <button
            type="button"
            aria-label={calibrating ? 'Open your mimic' : `Open your mimic, ${pct(f!.fidelity)}%`}
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
            className="flex h-9 items-center gap-1.5 rounded-full border border-rule bg-sheet pr-3 pl-2 text-[14px] font-medium leading-5 text-graphite tabular-nums"
          >
            {calibrating ? (
              <OverlapMark size={24} labels={false} calibrating />
            ) : (
              <OverlapMark size={24} labels={false} f={f!.fidelity} />
            )}
            {calibrating ? 'Learning' : `${pct(f!.fidelity)}%`}
          </button>
          <span className="px-1 text-[14px] leading-5 text-slate tabular-nums">{counter}</span>
          {menu(true)}
        </div>

        <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-2 lg:px-16 lg:pb-14">
          <div className="mt-auto w-full lg:mx-auto lg:my-auto lg:max-w-[640px]">
            {q ? (
              <QuestionView
                q={q}
                intro={
                  answeredCount === 0
                    ? `Your mimic guesses before you answer.${showGuesses ? " You'll see its guess after." : ''}`
                    : firstOfVisit
                      ? `Welcome back. ${answeredCount} of ~${target} answered.`
                      : answeredCount >= target
                        ? `You've reached about ${target}. Keep going to sharpen your mimic, or finish for now.`
                        : null
                }
                picked={picked}
                reveal={reveal}
                answered={answered}
                disabled={sending || answered || offline}
                offline={offline}
                error={error}
                first={answeredCount === 0}
                reasonOpen={reasonOpen}
                reason={reason}
                reasonSent={reasonSent}
                onReasonToggle={() => {
                  if (reasonOpen) setReason('');
                  setReasonOpen(!reasonOpen);
                }}
                onReason={setReason}
                onPick={pick}
                onNext={advance}
                nextRef={nextRef}
                optionRef={(i) => (el) => {
                  optionRefs.current[i] = el;
                }}
                onOptionKey={onOptionKey}
                tabIndexFor={tabIndexFor}
              />
            ) : data?.status === 'budget' ? (
              <Done
                id={id}
                title="Your mimic has learned all it can for now"
                body={
                  s && s.mimic.spendUsd >= s.mimic.budgetUsd
                    ? "This session reached its spending limit. You can still answer questions yourself on your mimic's page."
                    : "This session used its share of the budget. The rest is kept for your mimic's page, where you can ask it questions, teach it and curate Persona.md."
                }
              />
            ) : (
              <div className="flex items-center gap-3 py-16 text-[16px] text-slate" aria-live="polite">
                <Spinner /> {data ? 'Preparing your next question…' : 'Loading…'}
              </div>
            )}
          </div>
        </div>
      </main>

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        {panel(true)}
      </BottomSheet>
    </div>
  );
}

interface QuestionViewProps {
  q: PublicQuestion;
  intro: string | null;
  picked: string | null;
  reveal: Reveal | null;
  answered: boolean;
  disabled: boolean;
  offline: boolean;
  error: string | null;
  first: boolean;
  reasonOpen: boolean;
  reason: string;
  reasonSent: boolean;
  onReasonToggle: () => void;
  onReason: (s: string) => void;
  onPick: (key: string) => void;
  onNext: () => void;
  nextRef: React.Ref<HTMLButtonElement>;
  optionRef: (i: number) => (el: HTMLButtonElement | null) => void;
  onOptionKey: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  tabIndexFor: (i: number) => number;
}

function QuestionView(p: QuestionViewProps) {
  const { q, reveal } = p;
  const pctOf = (key: string) => (reveal ? Math.round((reveal.dist[key] ?? 0) * 100) : null);
  const heading = (
    <h1 className="m-0 mb-6 font-serif text-[26px] font-normal leading-[34px] text-graphite [text-wrap:pretty] lg:mb-0 lg:max-w-[560px] lg:text-[36px] lg:leading-[44px]">
      {q.prompt}
    </h1>
  );
  return (
    <div className="flex flex-col lg:gap-8">
      {p.intro ? (
        <div className="mb-6 flex flex-col gap-4 lg:mb-0">
          <p role="status" className="m-0 text-[16px] leading-6 text-slate">
            {p.intro}
          </p>
          <div className="[&>h1]:mb-0">{heading}</div>
        </div>
      ) : (
        heading
      )}

      {q.type === 'score' ? (
        <ScaleControl
          keys={q.options.map((o) => o.key)}
          lo={q.options[0]!.label}
          hi={q.options.at(-1)!.label}
          picked={p.picked}
          dist={reveal?.dist ?? null}
          disabled={p.disabled}
          onPick={p.onPick}
          onKeyDown={p.onOptionKey}
          refFor={p.optionRef}
          tabIndexFor={p.tabIndexFor}
        />
      ) : (
        <div
          role="radiogroup"
          aria-label={q.prompt}
          className={cn(q.type === 'noul' ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3')}
        >
          {q.options.map((o, i) => (
            <OptionButton
              key={o.key}
              ref={p.optionRef(i)}
              label={o.label}
              hint={q.type === 'noul' ? (o.key === 'yes' ? 'Y' : 'N') : String(i + 1)}
              center={q.type === 'noul'}
              pct={pctOf(o.key)}
              you={p.picked === o.key}
              mimic={!!reveal && reveal.optionKey === o.key}
              disabled={p.disabled}
              tabIndex={p.tabIndexFor(i)}
              onPick={() => p.onPick(o.key)}
              onKeyDown={p.onOptionKey}
            />
          ))}
        </div>
      )}

      {/* Fixed-height action area: the reveal never moves anything above it. */}
      <div className="flex h-[120px] flex-none flex-col justify-end gap-2 lg:h-[112px] lg:gap-3">
        {p.reasonOpen && !p.answered && (
          <textarea
            aria-label="Your reason (optional, never scored)"
            placeholder="Why? Optional, never scored."
            maxLength={1000}
            value={p.reason}
            onChange={(e) => p.onReason(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: opened on request
            autoFocus
            className="h-14 w-full resize-none rounded-[8px] border border-rule bg-sheet px-3 py-2 text-[14px] leading-5 text-graphite placeholder:text-slate focus-visible:rounded-[8px]"
          />
        )}
        <Status reveal={reveal} q={q} picked={p.picked} offline={p.offline} error={p.error} />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={p.onReasonToggle}
            disabled={p.answered}
            title={p.answered ? 'Reasons go in before you answer.' : undefined}
            className="h-11 p-0 text-[14px] font-medium leading-5 text-slate hover:text-graphite disabled:cursor-default disabled:hover:text-slate"
          >
            {p.answered && p.reasonSent
              ? 'Reason added'
              : p.reasonOpen && !p.answered
                ? 'Remove reason'
                : 'Add a reason (optional)'}
          </button>
          {p.answered ? (
            <NextButton ref={p.nextRef} onClick={p.onNext} disabled={p.offline} />
          ) : (
            p.first && (
              <span className="hidden items-center gap-1.5 text-[14px] leading-5 whitespace-nowrap text-slate lg:flex">
                <Kbd>{q.type === 'noul' ? 'Y / N' : `1–${q.options.length}`}</Kbd>
                <span>to answer,</span>
                <Kbd>Enter</Kbd>
                <span>for the next question</span>
              </span>
            )
          )}
        </div>
      </div>
      {/* A scale's reveal adds its bars (84 px); reserve them below so the prompt and scale never move. */}
      {q.type === 'score' && !reveal && <div aria-hidden="true" className="h-[84px] flex-none lg:-mt-8" />}
    </div>
  );
}

function Status({
  reveal,
  q,
  picked,
  offline,
  error,
}: {
  reveal: Reveal | null;
  q: PublicQuestion;
  picked: string | null;
  offline: boolean;
  error: string | null;
}) {
  let tone: 'moss' | 'rust' | 'slate' | null = null;
  let text = '';
  if (error) {
    tone = 'rust';
    text = error;
  } else if (offline) {
    tone = 'slate';
    text = "Saved on this device. It will be sent when you're back online.";
  } else if (reveal && picked) {
    ({ tone, text } = verdictOf(q, reveal, picked));
  }
  if (!tone) return null;
  const Icon = error || tone === 'rust' ? CrossIcon : tone === 'moss' ? CheckIcon : MinusIcon;
  return (
    <div
      role="status"
      className={cn(
        'animate-reveal flex items-start gap-2 text-[16px] leading-6',
        tone === 'moss' ? 'text-moss' : tone === 'rust' ? 'text-rust' : 'text-slate',
      )}
    >
      <Icon className="mt-0.5 flex-none" />
      <span>{text}</span>
    </div>
  );
}

function Done({ id, title, body }: { id: string; title: string; body: string }) {
  return (
    <div className="py-10">
      <h1 className="m-0 font-serif text-[26px] font-normal leading-[34px] text-graphite lg:text-[36px] lg:leading-[44px]">
        {title}
      </h1>
      <p className="mt-2 text-[16px] leading-6 text-slate">{body}</p>
      <Link
        href={`/m/${id}/mimic`}
        className="mt-6 inline-block text-[16px] text-ink underline underline-offset-2"
      >
        Go to your mimic
      </Link>
    </div>
  );
}
