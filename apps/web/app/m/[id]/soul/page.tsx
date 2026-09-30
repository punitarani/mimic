'use client';
import type {
  BoundaryKind,
  SoulCuration,
  SoulItem,
  SoulSave,
  SoulSection,
  SoulView,
  SpeakAsMe,
} from '@mimic/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/brand';
import { CodeIcon, CrossIcon, DocIcon } from '@/components/session/icons';
import { Button, buttonClass, Card, cn, ErrorText, Input, Spinner, Textarea } from '@/components/ui';
import { api } from '@/lib/api';

type SaveState = 'saved' | 'saving' | 'error';
const SAVE_DELAY_MS = 600;
const RECORD_PREVIEW = 8;

/** SOUL.md (ADR-0035): choose what goes in, reword what was inferred, add your own words, then download. */
export default function SoulPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['soul', id], queryFn: () => api.soul(id) });
  const [curation, setCuration] = useState<SoulCuration | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [tab, setTab] = useState<'curate' | 'preview'>('curate');

  // Saves go out one at a time, newest state last; each carries an increasing rev, and the server ignores a save
  // older than the one it has, so out-of-order arrival (for example the keepalive flush on leaving) can't regress it.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SoulSave | null>(null);
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
      const v = await api.curateSoul(id, next);
      if (!pending.current) {
        qc.setQueryData(['soul', id], v);
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
    (next: SoulCuration) => {
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
      if (pending.current) api.curateSoulOnLeave(id, pending.current);
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
          <h1 className="font-serif text-3xl tracking-tight">SOUL.md</h1>
          <p className="text-[15px] text-muted">
            A file any AI agent can read to predict and represent you: your values, beliefs and biases, and
            above all how you make decisions. Set your boundaries, choose what goes in, reword what was
            inferred, add your own words, then download it.
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
  view: SoulView;
  save: SaveState;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // The file on the server matches the page only once the latest change is saved.
  const busy = save !== 'saved';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <a
        href={busy ? undefined : `/api/mimics/${id}/soul.md`}
        aria-disabled={busy}
        download
        className={buttonClass('primary')}
      >
        <DocIcon width={18} height={18} />
        Download SOUL.md
      </a>
      <a
        href={busy ? undefined : `/api/mimics/${id}/soul.md?profile=core`}
        aria-disabled={busy}
        download
        className={buttonClass('secondary')}
        title="Everything except the appendix of answers, for system prompts with a small budget"
      >
        <CodeIcon width={18} height={18} />
        Core only
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
      <span className="basis-full text-[13px] text-muted">
        About {formatTokens(view.tokens.full)} tokens; the core alone is {formatTokens(view.tokens.core)}.
      </span>
      {save === 'error' && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}K`;
}

function DraftCard({
  id,
  view,
  onError,
}: {
  id: string;
  view: SoulView;
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
      qc.setQueryData(['soul', id], await api.draftSoul(id));
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
          {busy ? 'Writing… about a minute' : draft ? 'Rewrite' : 'Write the inferred sections'}
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
  view: SoulView;
  curation: SoulCuration;
  update: (c: SoulCuration) => void;
}) {
  const toggle = (list: string[], key: string, include: boolean) =>
    include ? list.filter((k) => k !== key) : [...list, key];
  const setSection = (sid: SoulSection['id'], on: boolean) =>
    update({ ...curation, disabled: toggle(curation.disabled, sid, on) as SoulCuration['disabled'] });
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
          <label htmlFor="soul-name" className="block text-sm font-medium">
            Name in the file
          </label>
          <Input
            id="soul-name"
            placeholder={view.name}
            maxLength={120}
            value={curation.name ?? ''}
            onChange={(e) => update({ ...curation, name: e.target.value || null })}
          />
        </div>
        <SectionToggle
          section={view.sections.find((s) => s.id === 'boundaries')!}
          on={!curation.disabled.includes('boundaries')}
          onChange={(on) => setSection('boundaries', on)}
        >
          <Boundaries
            value={curation.boundaries}
            onChange={(boundaries) => update({ ...curation, boundaries })}
          />
        </SectionToggle>
        <SpeakingAsYou
          value={curation.speakAsMe}
          onChange={(speakAsMe) => update({ ...curation, speakAsMe })}
        />
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
        <SectionToggle
          section={view.sections.find((s) => s.id === 'voice')!}
          on={!curation.disabled.includes('voice')}
          onChange={(on) => setSection('voice', on)}
        >
          <VoiceSamples
            value={curation.voiceSamples}
            onChange={(voiceSamples) => update({ ...curation, voiceSamples })}
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

const BOUNDARY_KINDS: Array<{ kind: BoundaryKind; label: string }> = [
  { kind: 'never', label: 'Never' },
  { kind: 'always', label: 'Always' },
  { kind: 'ask', label: 'Ask me first' },
];
const MAX_BOUNDARIES = 20;

/** Rules any agent must follow for the person; blank rows are kept while editing and left out of the file. */
function Boundaries({
  value,
  onChange,
}: {
  value: SoulCuration['boundaries'];
  onChange: (v: SoulCuration['boundaries']) => void;
}) {
  const set = (i: number, patch: Partial<SoulCuration['boundaries'][number]>) =>
    onChange(value.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="space-y-2">
      {value.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position while typed
        <div key={i} className="flex gap-2">
          <select
            aria-label={`Rule ${i + 1} kind`}
            value={b.kind}
            onChange={(e) => set(i, { kind: e.target.value as BoundaryKind })}
            className="h-11 shrink-0 rounded-[10px] border border-line bg-raised px-2 text-[15px] hover:border-line-strong"
          >
            {BOUNDARY_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <Input
            aria-label={`Rule ${i + 1}`}
            maxLength={300}
            placeholder={
              b.kind === 'never'
                ? 'Accept meetings before 10am for me'
                : b.kind === 'ask'
                  ? 'Before spending more than $100'
                  : 'Reply within a day'
            }
            value={b.text}
            onChange={(e) => set(i, { text: e.target.value })}
          />
          <Button
            variant="ghost"
            aria-label={`Remove rule ${i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <CrossIcon width={16} height={16} />
          </Button>
        </div>
      ))}
      {value.length < MAX_BOUNDARIES && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange([...value, { kind: 'never', text: '' }])}
        >
          Add a rule
        </Button>
      )}
    </div>
  );
}

const SPEAK_AS_ME: Array<{ value: SpeakAsMe; label: string; hint: string }> = [
  { value: 'disclosed', label: 'When I ask, and it says it’s an AI', hint: 'The default.' },
  { value: 'yes', label: 'When I ask', hint: 'It may write as you without saying it’s an AI.' },
  { value: 'no', label: 'Never', hint: 'Agents only describe and predict you.' },
];

function SpeakingAsYou({ value, onChange }: { value: SpeakAsMe; onChange: (v: SpeakAsMe) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-lg font-medium">Speaking as you</legend>
      <p className="text-[13px] text-muted">Whether an agent may write or speak in your name.</p>
      <div className="space-y-1">
        {SPEAK_AS_ME.map((o) => (
          <label key={o.value} className="flex cursor-pointer gap-3 rounded-[10px] p-2 hover:bg-surface">
            <input
              type="radio"
              name="speak-as-me"
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-1 size-[18px] shrink-0 accent-[var(--color-graphite)]"
            />
            <span>
              <span className="block text-[15px]">{o.label}</span>
              <span className="block text-[13px] text-muted">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const MAX_VOICE_SAMPLES = 5;

/** A few real messages the person wrote, so agents that speak for them match the voice. */
function VoiceSamples({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="space-y-2">
      {value.map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: samples have no identity beyond their position while typed
        <div key={i} className="flex gap-2">
          <Textarea
            aria-label={`Sample ${i + 1}`}
            rows={3}
            maxLength={600}
            placeholder="Paste a message you wrote: an email, a chat reply, a note."
            value={v}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            variant="ghost"
            aria-label={`Remove sample ${i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <CrossIcon width={16} height={16} />
          </Button>
        </div>
      ))}
      {value.length < MAX_VOICE_SAMPLES && (
        <Button variant="secondary" size="sm" onClick={() => onChange([...value, ''])}>
          Add a sample
        </Button>
      )}
    </div>
  );
}

function SectionToggle({
  section,
  on,
  onChange,
  children,
}: {
  section: SoulSection;
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
  section: SoulSection;
  curation: SoulCuration;
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
  item: SoulItem;
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

function Meta({ item, edited }: { item: SoulItem; edited: boolean }) {
  const bits: string[] = [];
  if (edited) bits.push('edited by you');
  if (item.tentative) bits.push('tentative');
  if (item.trait) bits.push(item.trait.group);
  if (item.detail) bits.push(item.detail);
  if (item.answer?.why) bits.push(`Why: “${item.answer.why}”`);
  if (item.cites.length && !item.answer)
    bits.push(`from answers ${item.cites.map((c) => `#${c}`).join(', ')}`);
  if (!bits.length) return null;
  return <p className="text-[13px] text-muted">{bits.join(' · ')}</p>;
}
