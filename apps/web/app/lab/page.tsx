import { labOverview } from '@mimic/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { TopBar } from '@/components/brand';
import { LineChart, ScatterChart } from '@/components/charts';
import { ExperimentsPanel } from '@/components/lab-experiments';
import { deps, isAdmin } from '@/lib/server';

export const dynamic = 'force-dynamic';

const pct = (x: number | null | undefined, d = 0) =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`;
const num = (x: number, d = 3) => x.toFixed(d);
const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const ms = (x: number) => `${Math.round(x)} ms`;

export default async function Lab({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; exp?: string }>;
}) {
  const { deps: d, env } = await deps();
  if (!(await isAdmin(env))) notFound();
  const sp = await searchParams;
  const includeAll = sp.all === '1';
  // Arm curves default to the active experiment; `exp=all` groups every mimic by arm.
  const active = (await d.store.listExperiments()).find((e) => e.status === 'active');
  const experimentId = sp.exp === 'all' ? null : (sp.exp ?? active?.id ?? null);
  const o = await labOverview(d, { includeAll, experimentId });
  const href = (exp: string) => `/lab?${new URLSearchParams({ ...(includeAll ? { all: '1' } : {}), exp })}`;
  const inv = o.invariants;
  const invOk =
    !inv.incomplete && !inv.shadowStateMismatches && !inv.nonContextBaselines && !inv.sealingViolations;

  return (
    <div className="min-h-dvh">
      <TopBar>
        <span className="text-[14px] text-muted">Lab</span>
      </TopBar>
      <main className="mx-auto w-full max-w-6xl space-y-10 px-4 pb-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">Lab</h1>
            <p className="mt-1 text-[14px] text-muted">
              {o.scope === 'consented'
                ? 'Research metrics from mimics whose owners consented to research use.'
                : 'All mimics, including those without research consent (ops and local dev only).'}
            </p>
          </div>
          <nav className="flex gap-2 text-[14px]">
            <Link
              href="/lab"
              className={`rounded-full border px-3 py-1 ${o.scope === 'consented' ? 'border-graphite' : 'border-line text-muted'}`}
            >
              Consented
            </Link>
            <Link
              href="/lab?all=1"
              className={`rounded-full border px-3 py-1 ${o.scope === 'all' ? 'border-graphite' : 'border-line text-muted'}`}
            >
              All
            </Link>
          </nav>
        </div>

        <section className="grid gap-3 sm:grid-cols-4">
          <Stat label="Mimics" value={String(o.mimics)} />
          <Stat label="Total spend" value={usd(o.spend.totalUsd)} />
          <Stat
            label="Spend per mimic"
            value={`${usd(o.spend.meanPerMimicUsd)} · p95 ${usd(o.spend.p95PerMimicUsd)}`}
          />
          <Stat
            label="Invariants"
            value={
              invOk
                ? `✓ ${inv.servedQuestions} questions${inv.pending ? ` · ${inv.pending} pending` : ''}`
                : '✗ see below'
            }
            tone={invOk ? 'good' : 'bad'}
          />
        </section>

        {!invOk && (
          <Section title="Invariant violations">
            <ul className="text-[14px]">
              <li>Missing primary, baseline or shadow (served over 15 minutes ago): {inv.incomplete}</li>
              <li>Still pending (served in the last 15 minutes): {inv.pending}</li>
              <li>Shadow state ≠ primary state: {inv.shadowStateMismatches}</li>
              <li>Baselines that aren't context-only: {inv.nonContextBaselines}</li>
              <li>Sealing violations: {inv.sealingViolations}</li>
            </ul>
          </Section>
        )}

        <Section
          title="Predictors"
          note="Within-person comparison on identical questions. Lift is paired against the baseline."
        >
          <Table
            head={[
              'Predictor',
              'Role',
              'n',
              'Accuracy',
              'Top-1',
              'Log loss',
              'Brier',
              'ECE',
              'Lift',
              'Failed',
              '$/1k',
              'p50',
            ]}
            rows={o.predictors.map((p) => [
              <code key="id" className="text-[12px]">
                {p.predictorId}
              </code>,
              p.role,
              p.n,
              pct(p.accuracy, 1),
              pct(p.top1, 1),
              num(p.logLoss),
              num(p.brier),
              num(p.ece),
              p.lift === null ? '—' : `${p.lift >= 0 ? '+' : ''}${(p.lift * 100).toFixed(1)}`,
              `${p.failures} (${pct(p.failureRate, 1)})`,
              usd(p.usdPer1k),
              ms(p.p50LatencyMs),
            ])}
          />
        </Section>

        <Section
          title="Experiment arms"
          note="Fidelity after k answered questions, averaged over the arm's mimics that got that far. E3's primary metrics: questions until fidelity reaches ≥ 0.75 and stays there, and fidelity at 20 questions."
        >
          <nav className="mb-4 flex flex-wrap gap-2 text-[13px]">
            {[{ id: 'all', name: 'All mimics by arm' }, ...o.experiments].map((e) => {
              const on = (o.armExperimentId ?? 'all') === e.id;
              return (
                <Link
                  key={e.id}
                  href={href(e.id)}
                  className={`rounded-full border px-3 py-1 ${on ? 'border-graphite' : 'border-line text-muted'}`}
                >
                  {e.name}
                </Link>
              );
            })}
          </nav>
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[14px] font-medium">Fidelity vs. questions, per arm</h3>
              <LineChart
                xLabel="Questions answered"
                yLabel="Fidelity"
                series={o.arms.map((a) => ({
                  name: `${a.arm} (${a.mimics})`,
                  points: a.points.map((p) => ({ x: p.k, y: p.fidelity })),
                }))}
              />
            </div>
            <div>
              <h3 className="mb-2 text-[14px] font-medium">Fidelity per dollar</h3>
              <ScatterChart
                xLabel="Mean spend per mimic (USD)"
                yLabel="Final fidelity"
                points={o.arms
                  .filter((a) => a.meanFinalFidelity !== null)
                  .map((a) => ({ label: a.arm, x: a.meanSpendUsd, y: a.meanFinalFidelity! }))}
              />
            </div>
          </div>
          <div className="mt-4">
            <Table
              head={['Arm', 'Mimics', 'Final fidelity', 'Fidelity at 20', 'Questions to 0.75', 'Mean spend']}
              rows={o.arms.map((a) => [
                a.arm,
                a.mimics,
                pct(a.meanFinalFidelity, 1),
                pct(a.fidelityAt20, 1),
                a.questionsToTarget === null
                  ? `— (0 of ${a.mimics})`
                  : `${a.questionsToTarget} (${a.reachedTarget} of ${a.mimics})`,
                usd(a.meanSpendUsd),
              ])}
            />
          </div>
        </Section>

        <Section
          title="Configs and experiments"
          note="Configs are immutable; experiments allocate new mimics by hash(mimicId)."
        >
          <ExperimentsPanel configs={o.configs} experiments={o.experiments} />
        </Section>

        <Section title="Cost and latency per call type" note="From model_calls, last 30 days.">
          <Table
            head={['Purpose', 'Calls', 'Total', 'Mean', 'p50', 'p95', 'Errors', 'Models']}
            rows={o.calls.map((c) => [
              c.purpose,
              c.n,
              usd(c.costUsd),
              usd(c.meanCostUsd),
              ms(c.p50LatencyMs),
              ms(c.p95LatencyMs),
              pct(c.errorRate, 1),
              <span key="m" className="text-[12px] text-muted">
                {c.models.join(', ')}
              </span>,
            ])}
          />
        </Section>

        <div>
          <Section title="Eval runs">
            {o.evalRuns.length === 0 ? (
              <p className="text-[13px] text-muted">
                None yet. Publish one with `pnpm eval -- report --data … --run … --to local`.
              </p>
            ) : (
              <ul className="space-y-2 text-[13px]">
                {o.evalRuns.map((r) => (
                  <li key={r.id}>
                    <Link href={`/lab/evals/${r.id}`} className="font-medium underline underline-offset-2">
                      {r.name}
                    </Link>{' '}
                    · {r.status} · {new Date(r.createdAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-raised p-4">
      <p className="text-[12px] text-muted">{label}</p>
      <p
        className={`mt-1 text-lg font-medium ${tone === 'good' ? 'text-moss' : tone === 'bad' ? 'text-rust' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-medium">{title}</h2>
      {note && <p className="text-[13px] text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  if (!rows.length) return <p className="text-[13px] text-muted">No data yet.</p>;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-raised">
      <table className="w-full text-left text-[13px] tabular">
        <thead className="border-b border-line bg-surface text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static table rows
            <tr key={i}>
              {r.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static table cells
                <td key={j} className="whitespace-nowrap px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
