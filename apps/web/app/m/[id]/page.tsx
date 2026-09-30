'use client';
import type { NextResult, Reveal, UiSnapshot } from '@mimic/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/brand';
import { FidelityRings, ModelPanel } from '@/components/model-panel';
import { QuestionCard } from '@/components/question-card';
import { Button, ErrorText, Sheet, Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { enqueueAnswer, flushOutbox, newIdempotencyKey, pendingAnswers, sendAnswer } from '@/lib/outbox';

const REVEAL_MS = 600;

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [reveal, setReveal] = useState<(Reveal & { answer: string }) | null>(null);
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const shownAt = useRef(Date.now());

  const snap = useQuery({ queryKey: ['snapshot', id], queryFn: () => api.snapshot(id) });
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
          void qc.invalidateQueries({ queryKey: ['question', id] });
          void qc.invalidateQueries({ queryKey: ['snapshot', id] });
        }
      });
    };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [id, qc]);

  const data: NextResult | undefined = next.data;
  const question = data?.status === 'question' ? data.question : null;

  useEffect(() => {
    if (question) shownAt.current = Date.now();
  }, [question]);

  useEffect(() => {
    if (data?.status === 'identity') router.replace(`/m/${id}/identity`);
  }, [data?.status, id, router]);

  const submit = useCallback(
    async (value: string, why: string | undefined) => {
      if (!question) return;
      setSending(true);
      setError(null);
      const item = {
        mimicId: id,
        questionId: question.id,
        value,
        latencyMs: Math.min(3_600_000, Date.now() - shownAt.current),
        idempotencyKey: newIdempotencyKey(),
        createdAt: Date.now(),
        ...(why ? { why } : {}),
      };
      await enqueueAnswer(item); // durable before the network
      try {
        const res = await sendAnswer(item);
        // Fetch the next question while the reveal shows.
        const nextP = qc.fetchQuery({
          queryKey: ['question', id],
          queryFn: () => api.next(id),
          staleTime: 0,
        });
        if (res.reveal) {
          setReveal({ ...res.reveal, answer: value });
          await Promise.all([new Promise((r) => setTimeout(r, REVEAL_MS)), nextP.catch(() => null)]);
        } else {
          await nextP.catch(() => null);
        }
        setReveal(null);
        void qc.invalidateQueries({ queryKey: ['snapshot', id] });
      } catch (e) {
        if (e instanceof ApiError && e.status < 500 && e.status !== 429) {
          setError(e.message);
          void qc.invalidateQueries({ queryKey: ['question', id] });
        } else {
          setOffline(true); // kept in the outbox; retried on reconnect
        }
      } finally {
        setSending(false);
      }
    },
    [id, qc, question],
  );

  async function stop() {
    await api.stop(id).catch(() => null);
    router.push(`/m/${id}/mimic`);
  }

  const s: UiSnapshot | undefined = snap.data;
  const progress = data?.progress ?? s?.progress;
  const f = s?.fidelity;

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar>
        {s && (
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="flex items-center gap-1.5 rounded-full border border-line bg-raised py-1 pl-1 pr-3 text-[13px] lg:hidden"
            aria-label="Open your model"
          >
            <FidelityRings fidelity={f?.nScored ? f.fidelity : null} size={40} labels={false} />
            <span className="tabular">{f?.nScored ? `${Math.round(f.fidelity * 100)}%` : 'Model'}</span>
          </button>
        )}
        <Link href={`/m/${id}/mimic`} className="hidden text-[14px] text-muted hover:text-graphite sm:inline">
          Your mimic
        </Link>
      </TopBar>

      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-10 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <aside className="hidden lg:block" aria-label="Your model">
          <div className="sticky top-4 max-h-[calc(100dvh-5rem)] overflow-y-auto pr-2">
            {s ? <ModelPanel snap={s} /> : <Spinner />}
          </div>
        </aside>

        <main className="flex flex-col pt-4 lg:pt-10">
          <div className="mb-6 flex items-center justify-between text-[14px] text-muted">
            <span className="tabular">
              {progress
                ? `${Math.min(progress.answered + 1, Math.max(progress.target, progress.answered + 1))} of ~${progress.target}`
                : ''}
            </span>
            <Button variant="ghost" size="sm" onClick={stop}>
              Stop here
            </Button>
          </div>

          {offline && (
            <p
              className="mb-4 rounded-[10px] bg-ink-soft px-3 py-2 text-[14px] text-ink-strong"
              role="status"
            >
              Your answer is saved on this device and will be sent when you're back online.
            </p>
          )}
          <ErrorText>{error}</ErrorText>

          {question ? (
            <QuestionCard
              question={question}
              disabled={sending || offline}
              reveal={reveal}
              onSubmit={submit}
            />
          ) : data?.status === 'waiting' || !data ? (
            <div className="flex items-center gap-3 py-16 text-muted" aria-live="polite">
              <Spinner /> {data ? 'Preparing your next question…' : 'Loading…'}
            </div>
          ) : data.status === 'budget' ? (
            <Done
              id={id}
              title="Your mimic has learned all it can for now"
              body="This session reached its spending limit."
            />
          ) : null}

          {progress && progress.answered >= progress.target && question && (
            <p className="mt-8 text-[14px] text-muted">
              You've reached about {progress.target}. Keep going to sharpen your mimic, or{' '}
              <button type="button" className="underline underline-offset-2" onClick={stop}>
                stop here
              </button>
              .
            </p>
          )}
        </main>
      </div>

      <Sheet open={panelOpen} onClose={() => setPanelOpen(false)} title="Your model">
        {s ? <ModelPanel snap={s} /> : <Spinner />}
      </Sheet>
    </div>
  );
}

function Done({ id, title, body }: { id: string; title: string; body: string }) {
  return (
    <div className="py-10">
      <h1 className="prompt">{title}</h1>
      <p className="mt-2 text-muted">{body}</p>
      <Link href={`/m/${id}/mimic`} className="mt-6 inline-block underline underline-offset-2">
        Go to your mimic
      </Link>
    </div>
  );
}
