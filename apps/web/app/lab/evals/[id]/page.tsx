import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TopBar } from '@/components/brand';
import { ReportView } from '@/components/report';
import { deps, isAdmin } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** An eval run published with `mimic-eval report --to <env>` (PLAN §12.3). */
export default async function EvalRun({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { deps: d, env } = await deps();
  if (!(await isAdmin(env))) notFound();
  const run = (await d.store.listEvalRuns()).find((r) => r.id === id);
  if (!run) notFound();
  const report = run.r2ReportKey ? await d.blobs.get(run.r2ReportKey) : null;
  return (
    <div className="min-h-dvh">
      <TopBar>
        <Link href="/lab" className="text-[14px] text-muted hover:text-graphite">
          Lab
        </Link>
      </TopBar>
      <main className="mx-auto w-full max-w-5xl px-4 pb-20 sm:px-6">
        <h1 className="font-serif text-3xl tracking-tight">{run.name}</h1>
        <p className="mt-1 text-[13px] text-muted">
          {run.status} · {new Date(run.createdAt).toLocaleString()} · dataset{' '}
          <code>{run.datasetHash.slice(0, 16)}</code>
        </p>
        {report ? (
          <ReportView markdown={report} />
        ) : (
          <pre className="mt-6 overflow-x-auto rounded-[var(--radius-card)] border border-line bg-raised p-4 text-[12px]">
            {JSON.stringify(run.metrics, null, 2)}
          </pre>
        )}
      </main>
    </div>
  );
}
