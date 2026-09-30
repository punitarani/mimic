'use client';
import type { PersonaCuration, PersonaItem, PersonaSave, PersonaSection, PersonaView } from '@mimic/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/brand';
import { Button, Card, cn, ErrorText, Input, Spinner, Textarea } from '@/components/ui';
import { api } from '@/lib/api';

type SaveState = 'saved' | 'saving' | 'error';
const SAVE_DELAY_MS = 600;
const RECORD_PREVIEW = 8;

/** Persona.md (ADR-0031): choose what goes in, reword what was inferred, add your own words, then download. */
export default function PersonaPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['persona', id], queryFn: () => api.persona(id) });
  const [curation, setCuration] = useState<PersonaCuration | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [tab, setTab] = useState<'curate' | 'preview'>('curate');

  // Saves go out one at a time, newest state last; each carries an increasing rev, and the server ignores a save
  // older than the one it has, so out-of-order arrival (for example the keepalive flush on leaving) can't regress it.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PersonaSave | null>(null);
  const inFlight = useRef(false);
  const rev = useRef(0);

  useEffect(() => {
    if (q.data && curation === null) {
      setCuration(q.data.curation);
      rev.current = Math.max(rev.current, q.data.rev);
    }
  }, [q.data, curation]);

  const flush = useCallback(async () => {
    if (inFlight.current || !pending.current) return;
    const next = pending.current;
    pending.current = null;
    inFlight.current = true;
    try {
      const v = await api.curatePersona(id, next);
      if (!pending.current) {
        qc.setQueryData(['persona', id], v);
        setSave('saved');
        setSaveError(null);
      }
    } catch (e) {
      // A newer save supersedes this one; otherwise say so and offer a retry.
      if (!pending.current) {
        setSave('error');
        setSaveError(e instanceof Error ? e.message : 'Could not save.');
      }
    } finally {
      inFlight.current = false;
      if (pending.current && !timer.current) void flush();
    }
  }, [id, qc]);

  const update = useCallback(
    (next: PersonaCuration) => {
      setCuration(next);
      setSave('saving');
      rev.current = Math.max(Date.now(), rev.current + 1);
      pending.current = { rev: rev.current, curation: next };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
  );

  // Leaving the page (in-app navigation or closing the tab) sends any unsent change instead of dropping it.
  useEffect(() => {
    const leave = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (pending.current) api.curatePersonaOnLeave(id, pending.current);
      pending.current = null;
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [id]);

  const view = q.data;
  return (
    <div className="min-h-dvh">
      <TopBar>
        <Link href={`/m/${id}/mimic`} className="text-[14px] text-muted hover:text-graphite">
          Your mimic
        </Link>
      </TopBar>
      <main className="mx-auto w-full max-w-2xl space-y-8 px-4 pb-20 pt-4 sm:px-6">
        <header className="space-y-2">
          <h1 className="font-serif text-3xl tracking-tight">Persona.md</h1>
          <p className="text-[15px] text-muted">
            A file any AI agent can read to represent you: your values, beliefs and biases, and above all how
            you make decisions. Choose what goes in, reword what was inferred, add your own words, then
            download it.
          </p>
        </header>
        {!view || !curation ? (
          q.error ? (
            <ErrorText>{q.error.message}</ErrorText>
          ) : (
            <Spinner />
          )
        ) : (
          <>
            <FileActions id={id} view={view} save={save} onRetry={() => curation && update(curation)} />
            <ErrorText>{saveError}</ErrorText>
            <ErrorText>{draftError}</ErrorText>
            <DraftCard id={id} view={view} onError={setDraftError} />
            <div
              role="tablist"
              aria-label="View"
              className="inline-flex rounded-[10px] border border-line p-0.5"
            >
              {(['curate', 'preview'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'h-8 rounded-[8px] px-3 text-[14px]',
                    tab === t ? 'bg-graphite text-fog' : 'text-graphite-soft hover:text-graphite',
                  )}
                >
                  {t === 'curate' ? 'Choose what goes in' : 'Preview the file'}
                </button>
              ))}
            </div>
            {tab === 'curate' ? (
              <Curate view={view} curation={curation} update={update} />
            ) : (
              <Card className="p-4">
                <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
                  {view.markdown}
                </pre>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function FileActions({
  id,
  view,
  save,
  onRetry,
}: {
  id: string;
  view: PersonaView;
  save: SaveState;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // The file on the server matches the page only once the latest change is saved.
  const busy = save !== 'saved';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <a
        href={busy ? undefined : `/api/mimics/${id}/persona.md`}
        aria-disabled={busy}
        download
        className={cn(
          'inline-flex h-10 items-center rounded-[10px] px-4 text-[15px] font-medium',
          busy ? 'cursor-not-allowed bg-line-strong text-fog' : 'bg-graphite text-fog hover:bg-graphite-soft',
        )}
      >
        Download Persona.md
      </a>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          await navigator.clipboard.writeText(view.markdown);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="text-[13px] text-muted" aria-live="polite">
        {save === 'saving' ? 'Saving…' : save === 'error' ? 'Not saved' : 'Saved'}
      </span>
      {save === 'error' && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function DraftCard({
  id,
  view,
  onError,
}: {
  id: string;
  view: PersonaView;
  onError: (e: string | null) => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { draft, source, minAnswers } = view;
  const tooFew = source.answers < minAnswers;
  const write = async () => {
    setBusy(true);
    onError(null);
    try {
      qc.setQueryData(['persona', id], await api.draftPersona(id));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not write the persona.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-4">
      {draft ? (
        <p className="text-[15px]">
          The inferred sections were written from your {draft.newAnswers > 0 ? 'first ' : ''}
          {draft.answers} answers on {new Date(draft.createdAt).toLocaleDateString()}.
          {draft.newAnswers > 0 && (
            <span className="text-muted">
              {' '}
              You’ve answered {draft.newAnswers} more since. Rewrite to include them.
            </span>
          )}
        </p>
      ) : (
        <p className="text-[15px]">
          Mimic reads your {source.answers} answers and writes how you decide, what you value, what you
          believe and where your blind spots are. Every statement cites the answers behind it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={draft ? 'secondary' : 'primary'} onClick={write} disabled={busy || tooFew}>
          {busy ? 'Writing… up to a minute' : draft ? 'Rewrite' : 'Write the inferred sections'}
        </Button>
        {busy && <Spinner />}
      </div>
      {tooFew && <p className="text-[13px] text-muted">Answer at least {minAnswers} questions first.</p>}
      {draft && (
        <p className="text-[13px] text-muted">
          Rewriting replaces the inferred statements. Your own words, choices and sections stay; edits to
          statements that change are dropped.
        </p>
      )}
    </Card>
  );
}

function Curate({
  view,
  curation,
  update,
}: {
  view: PersonaView;
  curation: PersonaCuration;
  update: (c: PersonaCuration) => void;
}) {
  const toggle = (list: string[], key: string, include: boolean) =>
    include ? list.filter((k) => k !== key) : [...list, key];
  const setSection = (sid: PersonaSection['id'], on: boolean) =>
    update({ ...curation, disabled: toggle(curation.disabled, sid, on) as PersonaCuration['disabled'] });
  const setItem = (key: string, on: boolean) =>
    update({ ...curation, hidden: toggle(curation.hidden, key, on) });
  const setEdit = (key: string, text: string | null) => {
    const edits = { ...curation.edits };
    if (text === null) delete edits[key];
    else edits[key] = text;
    update({ ...curation, edits });
  };

  return (
    <div className="space-y-10">
      <div className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="persona-name" className="block text-sm font-medium">
            Name in the file
          </label>
          <Input
            id="persona-name"
            placeholder={view.name}
            maxLength={120}
            value={curation.name ?? ''}
            onChange={(e) => update({ ...curation, name: e.target.value || null })}
          />
        </div>
        <SectionToggle
          section={view.sections.find((s) => s.id === 'own_words')!}
          on={!curation.disabled.includes('own_words')}
          onChange={(on) => setSection('own_words', on)}
        >
          <Textarea
            aria-label="In your own words"
            rows={5}
            maxLength={6000}
            placeholder="How you like to decide, what you won't compromise on, opinions you hold. Markdown works."
            value={curation.notes}
            onChange={(e) => update({ ...curation, notes: e.target.value })}
          />
        </SectionToggle>
      </div>

      {view.sections
        .filter((s) => s.id !== 'own_words' && (s.items.length > 0 || s.id === 'guide'))
        .map((s) => (
          <SectionToggle
            key={s.id}
            section={s}
            on={!curation.disabled.includes(s.id)}
            onChange={(on) => setSection(s.id, on)}
          >
            <Items section={s} curation={curation} onToggle={setItem} onEdit={setEdit} />
          </SectionToggle>
        ))}
    </div>
  );
}

function SectionToggle({
  section,
  on,
  onChange,
  children,
}: {
  section: PersonaSection;
  on: boolean;
  onChange: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  const hid = `sec-${section.id}`;
  return (
    <section aria-labelledby={hid} className="space-y-3">
      <div className="flex items-start justify-between gap-4 border-b border-line pb-2">
        <div>
          <h2 id={hid} className={cn('text-lg font-medium', !on && 'text-muted')}>
            {section.title}
          </h2>
          <p className="text-[13px] text-muted">{section.about}</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 pt-1 text-[14px]">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => onChange(e.target.checked)}
            className="size-[18px] accent-[var(--color-graphite)]"
          />
          Include
        </label>
      </div>
      {on && children}
    </section>
  );
}

function Items({
  section,
  curation,
  onToggle,
  onEdit,
}: {
  section: PersonaSection;
  curation: PersonaCuration;
  onToggle: (key: string, on: boolean) => void;
  onEdit: (key: string, text: string | null) => void;
}) {
  const [all, setAll] = useState(false);
  if (!section.items.length) return null;
  const long = section.id === 'record' && section.items.length > RECORD_PREVIEW;
  const items = long && !all ? section.items.slice(-RECORD_PREVIEW) : section.items;
  return (
    <div className="space-y-1">
      {long && (
        <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
          {all ? `Show the last ${RECORD_PREVIEW}` : `Show all ${section.items.length}`}
        </Button>
      )}
      <ul className="space-y-1">
        {items.map((i) => (
          <Item
            key={i.key}
            item={i}
            single={section.id === 'unknowns'}
            included={!curation.hidden.includes(i.key)}
            edited={curation.edits[i.key]}
            onToggle={(on) => onToggle(i.key, on)}
            onEdit={(t) => onEdit(i.key, t)}
          />
        ))}
      </ul>
    </div>
  );
}

function Item({
  item,
  single,
  included,
  edited,
  onToggle,
  onEdit,
}: {
  item: PersonaItem;
  single: boolean;
  included: boolean;
  edited: string | undefined;
  onToggle: (on: boolean) => void;
  onEdit: (text: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const text = edited ?? item.text;
  const cid = `inc-${item.key}`;
  return (
    <li className={cn('rounded-[10px] p-2 hover:bg-surface', !included && 'opacity-60')}>
      <div className="flex gap-3">
        {!single && (
          <input
            id={cid}
            type="checkbox"
            checked={included}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Include: ${text}`}
            className="mt-1 size-[18px] shrink-0 accent-[var(--color-graphite)]"
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {editing ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                const t = draft.trim();
                onEdit(t && t !== item.text ? t : null);
                setEditing(false);
              }}
            >
              <Textarea
                aria-label="Edit statement"
                rows={3}
                maxLength={600}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <div className="flex gap-2">
                <Button size="sm" type="submit">
                  Save
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <p className={cn('text-[15px]', !included && 'line-through decoration-muted')}>
              {item.answer ? (
                <>
                  <span className="tabular text-muted">#{item.cites[0]} </span>
                  {text} <span className="text-muted">→</span>{' '}
                  <strong className="font-medium">{item.answer.chosen}</strong>
                </>
              ) : (
                text
              )}
            </p>
          )}
          <Meta item={item} edited={edited !== undefined} />
          {item.editable && !editing && (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(text);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              {edited !== undefined && (
                <Button size="sm" variant="ghost" onClick={() => onEdit(null)}>
                  Restore original
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Meta({ item, edited }: { item: PersonaItem; edited: boolean }) {
  const bits: string[] = [];
  if (edited) bits.push('edited by you');
  if (item.tentative) bits.push('tentative');
  if (item.group) bits.push(item.group);
  if (item.detail) bits.push(item.detail);
  if (item.answer?.why) bits.push(`Why: “${item.answer.why}”`);
  if (item.cites.length && !item.answer)
    bits.push(`from answers ${item.cites.map((c) => `#${c}`).join(', ')}`);
  if (!bits.length) return null;
  return <p className="text-[13px] text-muted">{bits.join(' · ')}</p>;
}
