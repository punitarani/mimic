'use client';
import { predicateLabel } from '@mimic/core/labels';
import { hostLabel, isWebLink, withScheme } from '@mimic/core/links';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { TopBar } from '@/components/brand';
import { Button, cn, ErrorText, Input, Spinner } from '@/components/ui';
import { api, type IdentityView } from '@/lib/api';

type Candidate = IdentityView['candidates'][number];

/**
 * Jev's same-person probability below which a profile is a namesake, listed under "Show more" rather than up front.
 * No profile is badged as the likely match: in a live check an ambiguous intake ("Pomona", a school and a city) put a
 * namesake first, and a badge would have pointed the person at them. Order alone carries Jev's ranking.
 */
const SHOW_P = 0.2;
/** When no profile reaches this, the copy says none looks like a close match. */
const CLOSE_P = 0.5;

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
  const refresh = () => qc.invalidateQueries({ queryKey: ['identity', id] });
  const confirm = useMutation({
    mutationFn: (candidateId: string | null) => api.confirm(id, candidateId),
    onSuccess: refresh,
    onError,
  });
  const finish = useMutation({
    mutationFn: () => api.finishIdentity(id),
    onSuccess: () => router.push(`/m/${id}`),
    onError,
  });
  // Owned here, not by the form, so the picker's buttons wait while a link search is on its way.
  const search = useMutation({
    mutationFn: (link: string) => api.searchAgain(id, link),
    onSuccess: () => {
      setError(null); // a new search makes any earlier error stale
      return refresh();
    },
  });
  const linkSearch = (label?: string) => (
    <LinkSearch onSearch={(url) => search.mutateAsync(url)} pending={search.isPending} label={label} />
  );
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
      <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-4 sm:px-6">
        <ErrorText>{error}</ErrorText>
        {(!data || status === 'searching') && (
          <Waiting
            title="Looking for your public profile"
            body="This usually takes a few seconds. You can skip it at any time."
          />
        )}

        {status === 'candidates' && data && (
          <CandidatePicker
            candidates={data.candidates.filter((c) => c.status === 'proposed')}
            busy={confirm.isPending || search.isPending}
            onConfirm={(candidateId) => {
              setError(null);
              confirm.mutate(candidateId);
            }}
            linkSearch={linkSearch()}
          />
        )}

        {status === 'none_found' && (
          <section aria-labelledby="none">
            <h1 id="none" className="font-serif text-3xl tracking-tight">
              We couldn't find your profile
            </h1>
            <p className="mt-2 text-slate">
              That's fine: your mimic learns from your answers. If you have a LinkedIn profile or a personal
              site, we can look it up.
            </p>
            {linkSearch('Link to your profile')}
            <Button className="mt-8 w-full sm:w-auto" size="lg" onClick={() => finish.mutate()}>
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
            <p className="mt-2 text-slate">
              Remove anything that's wrong or that you'd rather your mimic not know.
            </p>
            {data.facts.length === 0 ? (
              <p className="mt-6 text-slate">No facts yet.</p>
            ) : (
              <ul className="mt-6 divide-y divide-line rounded-[var(--radius-card)] border border-line bg-raised">
                {data.facts.map((f) => {
                  const removed = f.userState === 'removed';
                  return (
                    <li key={f.id} className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className={cn('min-w-0', removed && 'opacity-50')}>
                        <p className="text-[13px] text-slate">{predicateLabel(f.predicate)}</p>
                        <p className={cn('text-[15px]', removed && 'line-through')}>{f.object}</p>
                        <p className="text-[12px] text-slate">
                          Source:{' '}
                          {f.sourceUrl && isWebLink(f.sourceUrl) ? (
                            <a
                              href={f.sourceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="underline underline-offset-2"
                            >
                              {hostLabel(f.sourceUrl)}
                            </a>
                          ) : (
                            f.source
                          )}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
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
            <Button
              className="mt-6 w-full sm:w-auto"
              size="lg"
              onClick={() => finish.mutate()}
              disabled={finish.isPending}
            >
              Start answering
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}

/**
 * "Is this you?": profiles as a radio group, best match first. The person picks one and confirms, or says none of
 * them are; nothing is preselected (PLAN §9.2 step 3). Namesakes Jev scored low wait behind "Show more".
 */
function CandidatePicker({
  candidates,
  busy,
  onConfirm,
  linkSearch,
}: {
  candidates: Candidate[];
  busy: boolean;
  onConfirm: (candidateId: string | null) => void;
  linkSearch: React.ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const strong = candidates.filter((c) => c.fromLink || (c.samePerson ?? 0) >= SHOW_P);
  const upFront = strong.length ? strong.slice(0, 5) : candidates.slice(0, 3);
  const more = candidates.filter((c) => !upFront.includes(c));
  // A profile picked from "Show more" stays in view when the list collapses again.
  const shown = showAll ? candidates : candidates.filter((c) => upFront.includes(c) || c.id === selected);
  // The heading follows what's on screen. "Not me" rejects every candidate, including those behind "Show more", so
  // it's only offered when there is just one.
  const oneShown = shown.length === 1;
  const onlyOne = candidates.length === 1;
  const confident = candidates.some((c) => c.fromLink || (c.samePerson ?? 0) >= CLOSE_P);
  const chosen = candidates.find((c) => c.id === selected);

  return (
    <section aria-labelledby="pick">
      <h1 id="pick" className="font-serif text-3xl tracking-tight">
        {oneShown ? 'Is this you?' : 'Is one of these you?'}
      </h1>
      <p className="mt-2 text-slate">
        {confident
          ? "Pick your profile. Next, you'll see what we take from it and can remove any of it."
          : "None of these look like a close match. If you're not here, search with a link below."}
      </p>

      <fieldset className="mt-6 space-y-3">
        <legend className="sr-only">Profiles</legend>
        {shown.map((c) => (
          <CandidateCard key={c.id} c={c} checked={selected === c.id} onSelect={() => setSelected(c.id)} />
        ))}
      </fieldset>
      {more.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 -ml-3"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show fewer' : `Show ${more.length} more with a similar name`}
        </Button>
      )}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button
          size="lg"
          className="w-full sm:w-auto"
          disabled={!chosen || busy}
          onClick={() => chosen && onConfirm(chosen.id)}
        >
          {busy ? 'Saving…' : 'This is me'}
        </Button>
        <Button
          size="lg"
          variant="secondary"
          className="w-full sm:w-auto"
          disabled={busy}
          onClick={() => onConfirm(null)}
        >
          {onlyOne ? 'Not me' : 'None of these'}
        </Button>
      </div>

      {linkSearch}
    </section>
  );
}

function CandidateCard({ c, checked, onSelect }: { c: Candidate; checked: boolean; onSelect: () => void }) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-[12px] border bg-sheet p-4 transition-colors',
        checked
          ? 'border-graphite bg-[linear-gradient(var(--g8),var(--g8))] ring-1 ring-graphite'
          : 'border-rule hover:border-slate',
      )}
    >
      <input
        type="radio"
        name="candidate"
        value={c.id}
        checked={checked}
        onChange={onSelect}
        className="mt-[3px] size-[18px] shrink-0 accent-[var(--color-graphite)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-graphite">{c.name}</span>
          {c.fromLink && <Tag className="bg-ink10 text-ink">Your link</Tag>}
        </span>
        {c.headline && (
          <span className="mt-0.5 line-clamp-2 block text-[15px] text-graphite-soft">{c.headline}</span>
        )}
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-slate">
          {c.location && <span className="truncate">{c.location}</span>}
          {c.location && <span aria-hidden="true">·</span>}
          {isWebLink(c.url) ? (
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer noopener"
              className="underline decoration-rule underline-offset-2 hover:text-graphite hover:decoration-slate"
            >
              {c.source}
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <span>{c.source}</span>
          )}
        </span>
      </span>
    </label>
  );
}

function Tag({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-medium leading-4', className)}>
      {children}
    </span>
  );
}

/** "Not here? Search with a link": a new search led by the person's LinkedIn or personal site. */
function LinkSearch({
  onSearch,
  pending,
  label,
}: {
  onSearch: (url: string) => Promise<unknown>;
  pending: boolean;
  /** Set when the page already explains the search; otherwise it follows a list as "Not here?". */
  label?: string | undefined;
}) {
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const url = withScheme(link);
    if (!url) return;
    if (!isWebLink(url)) {
      setError("That doesn't look like a web link. Try one like linkedin.com/in/you.");
      return;
    }
    setError(null);
    onSearch(url).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Something went wrong.'),
    );
  }
  return (
    <form onSubmit={submit} className={cn(label ? 'mt-6' : 'mt-8 border-t border-rule pt-6')} noValidate>
      <label htmlFor="identity-link" className="block text-[15px] font-medium text-graphite">
        {label ?? 'Not here? Search with a link'}
      </label>
      {!label && (
        <p className="mt-0.5 text-[13px] text-slate">
          A link to your LinkedIn profile or personal site finds you much more reliably.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Input
          id="identity-link"
          type="url"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="linkedin.com/in/you"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          className="h-11 shrink-0"
          disabled={!link.trim() || pending}
        >
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </form>
  );
}

function Waiting({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-start gap-3 py-10" aria-live="polite">
      <Spinner />
      <h1 className="font-serif text-3xl tracking-tight">{title}</h1>
      <p className="text-slate">{body}</p>
    </div>
  );
}
