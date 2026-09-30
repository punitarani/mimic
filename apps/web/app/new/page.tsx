'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/brand';
import { Button, Checkbox, ErrorText, Field, Input } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { INVITE_PARAM, inviteFromQuery } from '@/lib/invite';

export default function NewMimic() {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-6 sm:px-6">
        <h1 className="font-serif text-3xl tracking-tight">Tell us who you are</h1>
        <p className="mt-2 text-muted">
          This is only used to describe you to your mimic. Fields marked * are required.
        </p>
        {/* The page is prerendered (ADR-0023); reading the query string renders the form on the client. */}
        <Suspense fallback={<FormSkeleton />}>
          <IntakeFromLink />
        </Suspense>
      </main>
    </div>
  );
}

/** `/new?invite=CODE` fills the invite code in. A different link gets a fresh form. */
function IntakeFromLink() {
  const invite = inviteFromQuery(useSearchParams().get(INVITE_PARAM));
  return <IntakeForm key={invite ?? ''} invite={invite} />;
}

function IntakeForm({ invite }: { invite: string | null }) {
  const router = useRouter();
  const [f, setF] = useState({
    inviteCode: invite ?? '',
    name: '',
    location: '',
    occupation: '',
    employer: '',
    link: '',
  });
  // A code from the link stays locked until the server rejects it; then the person can type another.
  const [inviteLocked, setInviteLocked] = useState(invite !== null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const [attest, setAttest] = useState(false);
  const [search, setSearch] = useState(true);
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });

  const unlocked = invite !== null && !inviteLocked;
  useEffect(() => {
    if (unlocked) inviteRef.current?.focus();
  }, [unlocked]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!attest) {
      setError('Please confirm you are building a mimic of yourself.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.createMimic({
        inviteCode: f.inviteCode,
        name: f.name,
        location: f.location,
        ...(f.occupation ? { occupation: f.occupation } : {}),
        ...(f.employer ? { employer: f.employer } : {}),
        ...(f.link ? { link: f.link } : {}),
        attestSelf: true,
        consentSearch: search,
        consentResearch: research,
      });
      router.push(r.identity ? `/m/${r.mimicId}/identity` : `/m/${r.mimicId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
      if (err instanceof ApiError && err.status === 403) setInviteLocked(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
      <Field
        label="Invite code"
        htmlFor="invite"
        required
        hint={inviteLocked ? 'Filled in from your invite link.' : undefined}
      >
        <Input
          ref={inviteRef}
          id="invite"
          value={f.inviteCode}
          onChange={set('inviteCode')}
          disabled={inviteLocked}
          required
          autoComplete="off"
        />
      </Field>
      <Field label="Name" htmlFor="name" required>
        <Input id="name" value={f.name} onChange={set('name')} required autoComplete="name" />
      </Field>
      <Field
        label="Location"
        htmlFor="location"
        required
        hint="City and country, for example Lisbon, Portugal."
      >
        <Input
          id="location"
          value={f.location}
          onChange={set('location')}
          required
          autoComplete="address-level2"
        />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Occupation" htmlFor="occupation">
          <Input
            id="occupation"
            value={f.occupation}
            onChange={set('occupation')}
            autoComplete="organization-title"
          />
        </Field>
        <Field label="Employer" htmlFor="employer">
          <Input id="employer" value={f.employer} onChange={set('employer')} autoComplete="organization" />
        </Field>
      </div>
      <Field
        label="One link"
        htmlFor="link"
        hint="LinkedIn or a personal site. It makes finding you much more accurate."
      >
        <Input id="link" type="url" value={f.link} onChange={set('link')} placeholder="https://" />
      </Field>
      <div className="space-y-4 border-t border-line pt-5">
        <Checkbox id="attest" checked={attest} onChange={setAttest} label="I'm building a mimic of myself" />
        <Checkbox
          id="search"
          checked={search}
          onChange={setSearch}
          label="Search the public web for information about me"
          hint="You'll confirm which profile is you and can remove any fact we find."
        />
        <Checkbox
          id="research"
          checked={research}
          onChange={setResearch}
          label="Use my answers, without my name or location, for research"
          hint="Only answers from people who check this are used to compare methods."
        />
      </div>
      <ErrorText>{error}</ErrorText>
      <Button
        type="submit"
        size="lg"
        disabled={busy || !f.name || !f.location || !f.inviteCode}
        className="w-full sm:w-auto"
      >
        {busy ? 'Creating…' : 'Continue'}
      </Button>
    </form>
  );
}

/** Same shape as the form, so nothing jumps when it renders. */
function FormSkeleton() {
  const field = (w: string) => (
    <div className="space-y-1.5">
      <div className={`h-4 ${w} rounded bg-line`} />
      <div className="h-11 rounded-[10px] border border-line bg-raised" />
    </div>
  );
  return (
    <div
      role="status"
      aria-label="Loading"
      className="mt-8 space-y-5 animate-pulse motion-reduce:animate-none"
    >
      {field('w-24')}
      {field('w-16')}
      {field('w-20')}
      <div className="grid gap-5 sm:grid-cols-2">
        {field('w-24')}
        {field('w-20')}
      </div>
      {field('w-16')}
    </div>
  );
}
