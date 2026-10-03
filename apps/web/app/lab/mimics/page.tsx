import { LAB_PEOPLE_SORTS, type LabPeopleSort, labMimics, POPULATIONS, type Population } from '@mimic/core';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { TopBar } from '@/components/brand';
import { Sparkline } from '@/components/charts';
import { DeleteMimicButton, DeletePersonButton } from '@/components/lab-mimics';
import { ago, Badge, Chip, LabNav, POPULATION_LABEL, pct, usd } from '@/components/lab-ui';
import { deps, isAdmin } from '@/lib/server';

export const dynamic = 'force-dynamic';

const PAGE = 50;

const SORT_LABEL: Record<LabPeopleSort, string> = {
  recent: 'Recently active',
  created: 'Newest',
  answers: 'Most answers',
  spend: 'Most spend',
};

interface Params {
  population?: string;
  consent?: string;
  q?: string;
  sort?: string;
  page?: string;
}

/** A repeated query parameter arrives as an array: read its first value. */
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** `/lab/mimics` (ADR-0076): every person and their mimics, with fidelity at a glance and hard delete. */
export default async function LabPeople({
  searchParams,
}: {
  searchParams: Promise<Record<keyof Params, string | string[] | undefined>>;
}) {
  const { deps: d, env } = await deps();
  if (!(await isAdmin(env))) notFound();
  const raw = await searchParams;
  const sp: Params = {
    population: first(raw.population),
    consent: first(raw.consent),
    q: first(raw.q),
    sort: first(raw.sort),
    page: first(raw.page),
  };
  // Real people by default: imported panels hold thousands of people and would bury them.
  const population: Population | 'all' =
    sp.population === 'all' ? 'all' : (POPULATIONS.find((p) => p === sp.population) ?? 'real');
  const consent = sp.consent === '1' || sp.consent === '0' ? sp.consent : undefined;
  const sort = LAB_PEOPLE_SORTS.find((s) => s === sp.sort) ?? 'recent';
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const q = sp.q?.trim() ?? '';

  const o = await labMimics(d, {
    ...(population === 'all' ? {} : { population }),
    ...(consent ? { consentResearch: consent === '1' } : {}),
    ...(q ? { query: q } : {}),
    sort,
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });
  const now = d.clock();
  const pages = Math.max(1, Math.ceil(o.totalPeople / PAGE));

  const href = (patch: Partial<Record<keyof Params, string | undefined>>) => {
    const next: Record<string, string> = {};
    const merged = { population, consent, q: q || undefined, sort, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) next[k] = v;
    if (next.population === 'real') delete next.population;
    if (next.sort === 'recent') delete next.sort;
    const qs = new URLSearchParams(next).toString();
    return qs ? `/lab/mimics?${qs}` : '/lab/mimics';
  };
  // Past the last page (its last person was just deleted, or a stale link): go to the last page that has people.
  if (page > pages) redirect(href({ page: pages > 1 ? String(pages) : undefined }));

  return (
    <div className="min-h-dvh">
      <TopBar>
        <span className="text-[14px] text-muted">Lab</span>
      </TopBar>
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-20 sm:px-6">
        <LabNav active="/lab/mimics" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">People</h1>
            <p className="mt-1 max-w-2xl text-[14px] text-muted">
              Everyone with a mimic, with or without research consent, for operations. Research numbers stay
              on the overview, which counts only real people who consented. Deleting is a hard delete across
              every store.
            </p>
          </div>
          <p className="text-[14px] text-muted tabular">
            {o.totalPeople} {o.totalPeople === 1 ? 'person' : 'people'} · {o.totalMimics}{' '}
            {o.totalMimics === 1 ? 'mimic' : 'mimics'}
          </p>
        </div>

        <div className="space-y-3">
          <form action="/lab/mimics" method="get" className="flex max-w-md gap-2">
            {population !== 'real' && <input type="hidden" name="population" value={population} />}
            {consent && <input type="hidden" name="consent" value={consent} />}
            {sort !== 'recent' && <input type="hidden" name="sort" value={sort} />}
            <label htmlFor="lab-q" className="sr-only">
              Search people
            </label>
            <input
              id="lab-q"
              name="q"
              defaultValue={q}
              placeholder="Name, occupation, place or ID"
              className="h-9 w-full rounded-[10px] border border-line bg-raised px-3 text-[14px] placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <button
              type="submit"
              className="h-9 rounded-[10px] border border-line bg-raised px-3 text-[14px] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Search
            </button>
            {q && (
              <Link
                href={href({ q: undefined })}
                className="self-center text-[13px] text-muted hover:text-graphite"
              >
                Clear
              </Link>
            )}
          </form>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
            <FilterGroup label="Who">
              {(['real', 'scripted', 'twin2k', 'all'] as const).map((p) => (
                <Chip key={p} href={href({ population: p })} on={population === p}>
                  {POPULATION_LABEL[p]} <span className="tabular opacity-70">{o.counts[p]}</span>
                </Chip>
              ))}
            </FilterGroup>
            <FilterGroup label="Research consent">
              <Chip href={href({ consent: undefined })} on={!consent}>
                Any
              </Chip>
              <Chip href={href({ consent: '1' })} on={consent === '1'}>
                Consented
              </Chip>
              <Chip href={href({ consent: '0' })} on={consent === '0'}>
                Not consented
              </Chip>
            </FilterGroup>
            <FilterGroup label="Sort">
              {LAB_PEOPLE_SORTS.map((s) => (
                <Chip key={s} href={href({ sort: s })} on={sort === s}>
                  {SORT_LABEL[s]}
                </Chip>
              ))}
            </FilterGroup>
          </div>
        </div>

        {o.people.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-line bg-raised p-6 text-[14px] text-muted">
            {q ? `No one matches "${q}".` : 'No one here yet.'}
          </p>
        ) : (
          // `relative` keeps the absolutely positioned sr-only header inside the scroller; without it the page
          // itself scrolls sideways on a phone.
          <div className="relative overflow-x-auto rounded-[var(--radius-card)] border border-line bg-raised">
            <table className="w-full text-left text-[13px] tabular">
              <thead className="border-b border-line bg-surface text-muted">
                <tr>
                  {[
                    'Person',
                    'Mimic',
                    'Status',
                    'Config',
                    'Answers',
                    'Fidelity',
                    'Accuracy',
                    'Spend',
                    'Active',
                    '',
                  ].map((h) => (
                    <th key={h || 'actions'} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h || <span className="sr-only">Actions</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              {o.people.map((p) => (
                <tbody key={p.participantId} className="border-b border-line last:border-b-0">
                  {p.mimics.map((m, i) => (
                    <tr key={m.id} className="align-top hover:bg-surface/60">
                      {i === 0 && (
                        <td
                          rowSpan={p.mimics.length}
                          className="whitespace-nowrap border-r border-line px-3 py-3"
                        >
                          <div className="flex flex-col items-start gap-1.5">
                            <code className="text-[12px] text-graphite" title={p.participantId}>
                              {shortId(p.participantId)}
                            </code>
                            {p.population !== 'real' && <Badge>{POPULATION_LABEL[p.population]}</Badge>}
                            <span className="text-[12px] text-muted">
                              since {new Date(p.createdAt).toLocaleDateString()}
                            </span>
                            {p.ownedMimics > p.mimics.length && (
                              <span className="text-[12px] text-muted">
                                {p.ownedMimics - p.mimics.length} more not shown
                              </span>
                            )}
                            <DeletePersonButton
                              participantId={p.participantId}
                              mimics={p.ownedMimics}
                              className="-ml-1.5"
                            />
                          </div>
                        </td>
                      )}
                      <td className="px-3 py-3">
                        <Link
                          href={`/lab/mimics/${m.id}`}
                          className="font-medium text-graphite underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {m.displayName}
                        </Link>
                        <p className="max-w-[240px] truncate text-[12px] text-muted">
                          {[m.occupation, m.location].filter(Boolean).join(' · ')}
                        </p>
                        <div className="mt-1">
                          {m.consentResearch ? (
                            <Badge tone="good">Research consent</Badge>
                          ) : (
                            <Badge>No research consent</Badge>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <Badge tone={m.status === 'learning' ? 'good' : 'neutral'}>{m.status}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span title={m.configHash}>{m.configLabel ?? m.configHash.slice(0, 8)}</span>
                        {m.arm && <p className="text-[12px] text-muted">arm {m.arm}</p>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">{m.answers}</td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-9 ${m.fidelity !== null && m.fidelity >= 0.75 ? 'text-moss' : ''}`}
                          >
                            {pct(m.fidelity)}
                          </span>
                          <Sparkline
                            values={m.fidelityCurve}
                            label={`Fidelity over ${m.fidelityCurve.length} answers`}
                          />
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {pct(m.accuracy)}
                        {m.baselineAccuracy !== null && (
                          <p className="text-[12px] text-muted">baseline {pct(m.baselineAccuracy)}</p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">{usd(m.spendUsd)}</td>
                      <td
                        className="whitespace-nowrap px-3 py-3 text-muted"
                        title={new Date(m.updatedAt).toLocaleString()}
                      >
                        {ago(m.updatedAt, now)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        <DeleteMimicButton id={m.id} name={m.displayName} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between text-[13px]">
            {page > 1 ? (
              <Link
                href={href({ page: page > 2 ? String(page - 1) : undefined })}
                className="hover:underline"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-muted tabular">
              Page {page} of {pages}
            </span>
            {page < pages ? (
              <Link href={href({ page: String(page + 1) })} className="hover:underline">
                Next →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </main>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}

/** ULIDs share their time prefix: show the random tail. Prefixed IDs (`script:…`) keep the prefix. */
function shortId(id: string): string {
  const [prefix, rest] = id.includes(':')
    ? [`${id.slice(0, id.indexOf(':') + 1)}`, id.slice(id.indexOf(':') + 1)]
    : ['', id];
  return rest.length > 10 ? `${prefix}…${rest.slice(-8)}` : id;
}
