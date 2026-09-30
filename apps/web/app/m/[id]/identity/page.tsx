'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { TopBar } from '@/components/brand';
import { Button, Card, cn, ErrorText, Spinner } from '@/components/ui';
import { api, type IdentityView } from '@/lib/api';

const PREDICATE_LABEL: Record<string, string> = {
  headline: 'Headline',
  jobTitle: 'Role',
  worksAt: 'Works at',
  workedAt: 'Worked at',
  educatedAt: 'Studied at',
  hasSkill: 'Skill',
  created: 'Project or writing',
  hasInterest: 'Interest',
  livesIn: 'Location',
  knowsAbout: 'Knows about',
};

export default function IdentityPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['identity', id],
    queryFn: () => api.identity(id),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'searching' || s === 'enriching' ? 1500 : false;
    },
  });
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong.');
  const confirm = useMutation({
    mutationFn: (candidateId: string | null) => api.confirm(id, candidateId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['identity', id] }),
    onError,
  });
  const finish = useMutation({
    mutationFn: () => api.finishIdentity(id),
    onSuccess: () => router.push(`/m/${id}`),
    onError,
  });
  const toggle = useMutation({
    mutationFn: (f: { id: string; userState: 'active' | 'removed' }) => api.setFact(id, f.id, f.userState),
    onMutate: async (f) => {
      qc.setQueryData<IdentityView>(['identity', id], (old) =>
        old
          ? { ...old, facts: old.facts.map((x) => (x.id === f.id ? { ...x, userState: f.userState } : x)) }
          : old,
      );
    },
    onError,
  });

  const data = q.data;
  const status = data?.status;

  return (
    <div className="min-h-dvh">
      <TopBar>
        <Button variant="ghost" size="sm" onClick={() => finish.mutate()} disabled={finish.isPending}>
          Skip
        </Button>
      </TopBar>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <ErrorText>{error}</ErrorText>
        {(!data || status === 'searching') && (
          <Waiting
            title="Looking for public profiles"
            body="This usually takes a few seconds. You can skip it at any time."
          />
        )}

        {status === 'candidates' && data && (
          <section aria-labelledby="pick">
            <h1 id="pick" className="font-serif text-3xl tracking-tight">
              Is one of these you?
            </h1>
            <p className="mt-2 text-muted">
              Pick your profile, or choose "None of these". We never pick for you.
            </p>
            {data.candidates.every((c) => (c.samePerson ?? 0) < 0.3) && (
              <p className="mt-3 rounded-[10px] bg-surface px-3 py-2 text-[14px] text-graphite-soft">
                None of these look like a strong match. Adding a link to your profile when you start helps.
              </p>
            )}
            <ul className="mt-6 space-y-3">
              {data.candidates.map((c) => (
                <li key={c.id}>
                  <Card className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="font-medium">{c.name}</p>
                      {c.headline && <p className="text-[15px] text-graphite-soft">{c.headline}</p>}
                      <p className="mt-1 text-[13px] text-muted">
                        {[c.location, c.source].filter(Boolean).join(' · ')}{' '}
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-2"
                        >
                          View
                        </a>
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => confirm.mutate(c.id)}
                      disabled={confirm.isPending}
                      aria-label={`This is me: ${c.name}`}
                    >
                      This is me
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              className="mt-4"
              onClick={() => confirm.mutate(null)}
              disabled={confirm.isPending}
            >
              None of these
            </Button>
          </section>
        )}

        {status === 'none_found' && (
          <section>
            <h1 className="font-serif text-3xl tracking-tight">We didn't find a match</h1>
            <p className="mt-2 text-muted">That's fine. Your mimic will learn from your answers.</p>
            <Button className="mt-6" size="lg" onClick={() => finish.mutate()}>
              Start answering
            </Button>
          </section>
        )}

        {status === 'enriching' && (
          <Waiting
            title="Collecting public details"
            body="We only use what you can review and remove next."
          />
        )}

        {(status === 'review' || status === 'done' || status === 'skipped') && data && (
          <section aria-labelledby="facts">
            <h1 id="facts" className="font-serif text-3xl tracking-tight">
              What we found
            </h1>
            <p className="mt-2 text-muted">
              Remove anything that's wrong or that you'd rather your mimic not know.
            </p>
            {data.facts.length === 0 ? (
              <p className="mt-6 text-muted">No facts yet.</p>
            ) : (
              <ul className="mt-6 divide-y divide-line rounded-[var(--radius-card)] border border-line bg-raised">
                {data.facts.map((f) => {
                  const removed = f.userState === 'removed';
                  return (
                    <li key={f.id} className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className={cn('min-w-0', removed && 'opacity-50')}>
                        <p className="text-[13px] text-muted">
                          {PREDICATE_LABEL[f.predicate] ?? f.predicate}
                        </p>
                        <p className={cn('text-[15px]', removed && 'line-through')}>{f.object}</p>
                        <p className="text-[12px] text-muted">
                          Source:{' '}
                          {f.sourceUrl ? (
                            <a
                              href={f.sourceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="underline underline-offset-2"
                            >
                              {safeHost(f.sourceUrl)}
                            </a>
                          ) : (
                            f.source
                          )}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => toggle.mutate({ id: f.id, userState: removed ? 'active' : 'removed' })}
                        aria-pressed={removed}
                      >
                        {removed ? 'Restore' : 'Remove'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Button className="mt-6" size="lg" onClick={() => finish.mutate()} disabled={finish.isPending}>
              Start answering
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}

function Waiting({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-start gap-3 py-10" aria-live="polite">
      <Spinner />
      <h1 className="font-serif text-3xl tracking-tight">{title}</h1>
      <p className="text-muted">{body}</p>
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
