'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { TopBar } from '@/components/brand';
import { ConfirmDelete } from '@/components/confirm-delete';
import { FidelityHeadline, KgMap } from '@/components/model-panel';
import { Playground } from '@/components/playground';
import { CodeIcon, DocIcon, TrashIcon } from '@/components/session/icons';
import { Button, buttonClass, Spinner } from '@/components/ui';
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

/** SOUL.md (ADR-0036): a portable portrait for any agent, curated on its own page. */
function Persona({ id }: { id: string }) {
  return (
    <section aria-labelledby="persona-h" className="space-y-3">
      <h2 id="persona-h" className="text-lg font-medium">
        Take your mimic anywhere
      </h2>
      <p className="text-[15px] text-muted">
        SOUL.md is a file any AI agent can read to represent you: your values, beliefs, opinions and biases,
        and above all how you make decisions. You choose what goes in.
      </p>
      <Link href={`/m/${id}/soul`} className={buttonClass('primary')}>
        Curate SOUL.md
      </Link>
    </section>
  );
}

function Manage({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  return (
    <section aria-labelledby="manage-h" className="space-y-4 border-t border-line pt-8">
      <h2 id="manage-h" className="text-lg font-medium">
        Your data
      </h2>
      <div className="flex flex-wrap gap-3">
        <a href={`/api/mimics/${id}/soul.md`} className={buttonClass('primary')} download>
          <DocIcon width={18} height={18} />
          Download SOUL.md
        </a>
        <a href={`/api/mimics/${id}/export`} className={buttonClass('secondary')} download>
          <CodeIcon width={18} height={18} />
          Download mimic.json
        </a>
        <Button variant="danger" onClick={() => setConfirming(true)}>
          <TrashIcon width={18} height={18} />
          Delete this mimic
        </Button>
      </div>
      <p className="text-[13px] text-muted">
        Deleting removes your answers, predictions, facts, snapshots and logs from every store. It can't be
        undone.
      </p>
      {confirming && (
        <ConfirmDelete
          onCancel={() => setConfirming(false)}
          onDelete={async () => {
            await api.remove(id);
            router.push('/');
          }}
        />
      )}
    </section>
  );
}
