'use client';
import type { PlaygroundPrediction } from '@mimic/core';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { TopBar } from '@/components/brand';
import { FidelityHeadline, KgMap } from '@/components/model-panel';
import { Button, Card, cn, ErrorText, Input, Spinner, Textarea } from '@/components/ui';
import { api, type Draft } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/outbox';

export default function MimicPage() {
  const { id } = useParams<{ id: string }>();
  const snap = useQuery({ queryKey: ['snapshot', id], queryFn: () => api.snapshot(id) });
  return (
    <div className="min-h-dvh">
      <TopBar>
        <Link href={`/m/${id}`} className="text-[14px] text-muted hover:text-graphite">
          Keep answering
        </Link>
      </TopBar>
      <main className="mx-auto w-full max-w-2xl space-y-12 px-4 pb-20 pt-4 sm:px-6">
        <section>
          <h1 className="font-serif text-3xl tracking-tight">Your mimic</h1>
          {snap.data ? (
            <div className="mt-6 space-y-10">
              <FidelityHeadline snap={snap.data} />
              {snap.data.kg.nodes.length > 1 && <KgMap snap={snap.data} />}
            </div>
          ) : (
            <Spinner className="mt-6" />
          )}
        </section>
        <Playground id={id} />
        <Persona id={id} />
        <Manage id={id} />
      </main>
    </div>
  );
}

/** PLAN §9.11: scenario → editable typed question → the mimic's guess → your own answer (scored separately). */
function Playground({ id }: { id: string }) {
  const [scenario, setScenario] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [withRationale, setWithRationale] = useState(false);
  const [result, setResult] = useState<PlaygroundPrediction | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState<'draft' | 'predict' | 'answer' | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const reset = () => {
    setDraft(null);
    setResult(null);
    setMine(null);
  };

  return (
    <section aria-labelledby="pg-h">
      <h2 id="pg-h" className="text-lg font-medium">
        Ask your mimic
      </h2>
      <p className="mt-1 text-[15px] text-muted">
        Describe a situation. Your mimic predicts what you'd do, then you answer for real.
      </p>
      <ErrorText>{error}</ErrorText>

      {!draft && (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run('draft', () => api.draft(id, scenario));
            if (r) setDraft(r.draft);
          }}
        >
          <Textarea
            aria-label="Scenario"
            rows={3}
            placeholder="A recruiter offers a role at a fast-growing startup, with a pay cut but more equity…"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          />
          <Button type="submit" disabled={scenario.trim().length < 8 || busy !== null}>
            {busy === 'draft' ? 'Writing the question…' : 'Turn into a question'}
          </Button>
        </form>
      )}

      {draft && !result && (
        <Card className="mt-4 space-y-4 p-4">
          <label className="block text-sm font-medium" htmlFor="pg-prompt">
            Question
          </label>
          <Input
            id="pg-prompt"
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Options</legend>
            {draft.options.map((o, i) => (
              <Input
                key={o.key}
                aria-label={`Option ${i + 1}`}
                value={o.label}
                disabled={draft.type === 'noul'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    options: draft.options.map((x) =>
                      x.key === o.key ? { ...x, label: e.target.value } : x,
                    ),
                  })
                }
              />
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-[14px]">
            <input
              type="checkbox"
              checked={withRationale}
              onChange={(e) => setWithRationale(e.target.checked)}
            />
            Also write one generated sentence explaining the guess
          </label>
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                const r = await run('predict', () => api.predict(id, { ...draft, rationale: withRationale }));
                if (r) setResult(r);
              }}
              disabled={busy !== null}
            >
              {busy === 'predict' ? 'Predicting…' : 'Ask my mimic'}
            </Button>
            <Button variant="ghost" onClick={reset}>
              Start over
            </Button>
          </div>
        </Card>
      )}

      {result && (
        <Card className="mt-4 space-y-4 p-4">
          <p className="prompt text-[1.35rem]">{result.question.prompt}</p>
          <ul className="space-y-1.5">
            {result.question.options.map((o) => {
              const p = result.dist[o.key] ?? 0;
              const chosen = mine === o.key;
              return (
                <li key={o.key}>
                  <button
                    type="button"
                    disabled={mine !== null || busy !== null}
                    onClick={async () => {
                      const r = await run('answer', () =>
                        api.answer(id, {
                          questionId: result.question.id,
                          value: o.key,
                          latencyMs: 0,
                          idempotencyKey: newIdempotencyKey(),
                        }),
                      );
                      if (r) setMine(o.key);
                    }}
                    className={cn(
                      'relative w-full overflow-hidden rounded-[10px] border px-3 py-2.5 text-left text-[15px]',
                      chosen ? 'border-graphite' : 'border-line hover:border-line-strong',
                    )}
                  >
                    <span
                      className="absolute inset-y-0 left-0 bg-ink-soft"
                      style={{ width: `${p * 100}%` }}
                      aria-hidden="true"
                    />
                    <span className="relative flex justify-between gap-3">
                      <span>
                        {o.label}
                        {chosen && <span className="ml-2 text-[13px] text-muted">your answer</span>}
                      </span>
                      <span className="tabular text-ink-strong">{Math.round(p * 100)}%</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[14px] text-muted">
            {mine === null
              ? 'Which would you actually pick? Your answer is stored and scored separately.'
              : mine === result.guess.optionKey
                ? '✓ Your mimic got it.'
                : '✗ Your mimic guessed differently.'}
          </p>
          {result.rationale && (
            <p className="rounded-[10px] bg-surface p-3 text-[14px]">
              <span className="mr-2 rounded-full border border-line px-1.5 text-[11px] uppercase tracking-wide text-muted">
                generated
              </span>
              {result.rationale}
            </p>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              setScenario('');
            }}
          >
            Ask another
          </Button>
        </Card>
      )}
    </section>
  );
}

/** Persona.md (ADR-0031): a portable portrait for any agent, curated on its own page. */
function Persona({ id }: { id: string }) {
  return (
    <section aria-labelledby="persona-h" className="space-y-3">
      <h2 id="persona-h" className="text-lg font-medium">
        Take your mimic anywhere
      </h2>
      <p className="text-[15px] text-muted">
        Persona.md is a file any AI agent can read to represent you: your values, beliefs, opinions and
        biases, and above all how you make decisions. You choose what goes in.
      </p>
      <Link
        href={`/m/${id}/persona`}
        className="inline-flex h-10 items-center rounded-[10px] bg-graphite px-4 text-[15px] font-medium text-fog hover:bg-graphite-soft"
      >
        Curate Persona.md
      </Link>
    </section>
  );
}

function Manage({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="manage-h" className="space-y-4 border-t border-line pt-8">
      <h2 id="manage-h" className="text-lg font-medium">
        Your data
      </h2>
      <div className="flex flex-wrap gap-3">
        <a
          href={`/api/mimics/${id}/export`}
          className="inline-flex h-10 items-center rounded-[10px] border border-line bg-raised px-4 text-[15px] font-medium hover:border-line-strong"
          download
        >
          Download mimic.json
        </a>
        <a
          href={`/api/mimics/${id}/persona.md`}
          className="inline-flex h-10 items-center rounded-[10px] border border-line bg-raised px-4 text-[15px] font-medium hover:border-line-strong"
          download
        >
          Download Persona.md
        </a>
        {!confirming ? (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Delete this mimic
          </Button>
        ) : (
          <div className="flex items-center gap-2 rounded-[10px] bg-rust-soft px-3 py-1.5">
            <span className="text-[14px] text-rust">Delete everything, permanently?</span>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.remove(id);
                  router.push('/');
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not delete.');
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      <p className="text-[13px] text-muted">
        Deleting removes your answers, predictions, facts, snapshots and logs from every store. It can't be
        undone.
      </p>
    </section>
  );
}
