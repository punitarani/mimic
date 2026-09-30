'use client';
import { withScheme } from '@mimic/core/links';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { AutocompleteInput } from '@/components/autocomplete';
import { CreditsLink, TopBar } from '@/components/brand';
import { Button, Checkbox, ErrorText, Field, fieldLabelId, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { loadOccupations, loadPlaces } from '@/lib/autocomplete';
import { INVITE_PARAM, inviteFromQuery } from '@/lib/invite';

export default function NewMimic() {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-xl flex-1 px-4 pb-16 pt-6 sm:px-6">
        <h1 className="font-serif text-3xl tracking-tight">Tell us who you are</h1>
        <p className="mt-2 text-muted">
          This is only used to describe you to your mimic. Fields marked * are required.
        </p>
        {/* The page is prerendered (ADR-0023): the static HTML carries the form with no code, and reading the
            query string on the client fills it in. */}
        <Suspense fallback={<IntakeForm invite={null} />}>
          <IntakeFromLink />
        </Suspense>
      </main>
      {/* The suggestions show licensed data, and invite links land here without passing the home page's footer. */}
      <footer className="mx-auto w-full max-w-xl px-4 pb-8 text-[13px] text-muted sm:px-6">
        <CreditsLink />
      </footer>
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
  // A code from the link stays locked until a submit fails; then the person can type another.
  const [inviteLocked, setInviteLocked] = useState(invite !== null);
  const [rejections, setRejections] = useState(0);
  const inviteRef = useRef<HTMLInputElement>(null);
  const [attest, setAttest] = useState(false);
  const [search, setSearch] = useState(true);
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setValue = (k: keyof typeof f) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setValue(k)(e.target.value);

  // After each failed submit of a linked code, put the cursor where the fix goes (once the field is enabled).
  useEffect(() => {
    if (rejections > 0 && invite !== null) inviteRef.current?.focus();
  }, [rejections, invite]);

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
        ...(f.link.trim() ? { link: withScheme(f.link) } : {}),
        attestSelf: true,
        consentSearch: search,
        consentResearch: research,
      });
      router.push(r.identity ? `/m/${r.mimicId}/identity` : `/m/${r.mimicId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
      setInviteLocked(false);
      setRejections((n) => n + 1);
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
        hint="Your city finds you best. A state or country works too."
      >
        <AutocompleteInput
          id="location"
          labelId={fieldLabelId('location')}
          value={f.location}
          onChange={setValue('location')}
          load={loadPlaces}
          required
          placeholder="Lisbon, Portugal"
        />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Occupation" htmlFor="occupation">
          <AutocompleteInput
            id="occupation"
            labelId={fieldLabelId('occupation')}
            value={f.occupation}
            onChange={setValue('occupation')}
            load={loadOccupations}
          />
        </Field>
        <Field label="Employer or school" htmlFor="employer">
          <Input id="employer" value={f.employer} onChange={set('employer')} autoComplete="organization" />
        </Field>
      </div>
      <Field
        label="One link"
        htmlFor="link"
        hint="LinkedIn or a personal site. It makes finding you much more accurate."
      >
        <Input
          id="link"
          type="url"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          value={f.link}
          onChange={set('link')}
          placeholder="linkedin.com/in/you"
        />
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
