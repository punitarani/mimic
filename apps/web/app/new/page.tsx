'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { TopBar } from '@/components/brand';
import { Button, Checkbox, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';

export default function NewMimic() {
  const router = useRouter();
  const [f, setF] = useState({
    inviteCode: '',
    name: '',
    location: '',
    occupation: '',
    employer: '',
    link: '',
  });
  const [attest, setAttest] = useState(false);
  const [search, setSearch] = useState(true);
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });

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
    }
  }

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-6 sm:px-6">
        <h1 className="font-serif text-3xl tracking-tight">Tell us who you are</h1>
        <p className="mt-2 text-muted">
          This is only used to describe you to your mimic. Fields marked * are required.
        </p>
        <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
          <Field label="Invite code" htmlFor="invite" required>
            <Input
              id="invite"
              value={f.inviteCode}
              onChange={set('inviteCode')}
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
              <Input
                id="employer"
                value={f.employer}
                onChange={set('employer')}
                autoComplete="organization"
              />
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
            <Checkbox
              id="attest"
              checked={attest}
              onChange={setAttest}
              label="I'm building a mimic of myself"
            />
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
      </main>
    </div>
  );
}
