'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { TopBar } from '@/components/brand';
import { FidelityHeadline, KgMap } from '@/components/model-panel';
import { Playground } from '@/components/playground';
import { CodeIcon, DocIcon, TrashIcon } from '@/components/session/icons';
import { Button, buttonClass, ErrorText, Spinner } from '@/components/ui';
import { api } from '@/lib/api';

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
        <Playground id={id} snap={snap.data} />
        <Persona id={id} />
        <Manage id={id} />
      </main>
    </div>
  );
}

/** Persona.md (ADR-0033): a portable portrait for any agent, curated on its own page. */
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
        <a href={`/api/mimics/${id}/persona.md`} className={buttonClass('primary')} download>
          <DocIcon width={18} height={18} />
          Download Persona.md
        </a>
        <a href={`/api/mimics/${id}/export`} className={buttonClass('secondary')} download>
          <CodeIcon width={18} height={18} />
          Download mimic.json
        </a>
        {!confirming ? (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            <TrashIcon width={18} height={18} />
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
