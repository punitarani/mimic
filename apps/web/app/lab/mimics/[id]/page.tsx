import { EngineError, type LabQuestionRow, labMimic, ROLLING_WINDOW } from '@mimic/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TopBar } from '@/components/brand';
import { LineChart } from '@/components/charts';
import { DeleteMimicButton, DeletePersonButton } from '@/components/lab-mimics';
import { ago, Badge, LabNav, ms, num, pct, Section, Stat, Table, usd } from '@/components/lab-ui';
import { deps, isAdmin } from '@/lib/server';

export const dynamic = 'force-dynamic';

const score = (x: number | null) =>
  x === null ? 'text-muted' : x >= 0.75 ? 'text-moss' : x <= 0.25 ? 'text-rust' : 'text-graphite';

/** `/lab/mimics/[id]` (ADR-0075): one mimic's questions, answers, guesses, accuracy over time and cost. */
export default async function LabMimicPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ shadows?: string }>;
}) {
  const { id } = await params;
  const { deps: d, env } = await deps();
  if (!(await isAdmin(env))) notFound();
  const showShadows = (await searchParams).shadows === '1';
  const o = await labMimic(d, id).catch((e: unknown) => {
    if (e instanceof EngineError && e.code === 'not_found') notFound();
    throw e;
  });
  const m = o.mimic;
  const now = d.clock();
  const last = o.fidelity.at(-1);
  const primary = o.predictors.find((p) => p.role === 'primary');
  const curves = o.curves.filter((c) => showShadows || c.role !== 'shadow');
  const hasShadows = o.curves.some((c) => c.role === 'shadow');

  return (
    <div className="min-h-dvh">
      <TopBar>
        <span className="text-[14px] text-muted">Lab</span>
      </TopBar>
      <main className="mx-auto w-full max-w-6xl space-y-10 px-4 pb-20 sm:px-6">
        <LabNav active="/lab/mimics" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-muted">
              <Link href="/lab/mimics" className="hover:text-graphite hover:underline">
                People
              </Link>{' '}
              / <code className="text-[12px]">{m.participantId}</code>
            </p>
            <h1 className="mt-1 font-serif text-3xl tracking-tight">{m.displayName}</h1>
            <p className="mt-1 text-[14px] text-muted">
              {[m.occupation, m.location].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.population !== 'real' && <Badge>{m.population}</Badge>}
              <Badge tone={m.status === 'learning' ? 'good' : 'neutral'}>{m.status}</Badge>
              <Badge>identity {m.identityState}</Badge>
              {m.consentResearch ? (
                <Badge tone="good">Research consent</Badge>
              ) : (
                <Badge>No research consent</Badge>
              )}
              <Badge>
                <span title={m.configHash}>{m.configLabel ?? m.configHash.slice(0, 8)}</span>
              </Badge>
              {m.arm && (
                <Badge>
                  {o.experimentName ? `${o.experimentName} · ` : ''}arm {m.arm}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Link
              href={`/m/${m.id}`}
              className="rounded-[6px] px-1.5 py-0.5 text-graphite hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Open session view
            </Link>
            <DeleteMimicButton id={m.id} name={m.displayName} redirectTo="/lab/mimics" />
            <DeletePersonButton
              participantId={m.participantId}
              mimics={o.siblings.length + 1}
              redirectTo="/lab/mimics"
            />
          </div>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Answers" value={String(m.answers)} />
          <Stat
            label="Fidelity"
            value={last ? `${pct(last.fidelity)} (${pct(last.ciLow)}–${pct(last.ciHigh)})` : '—'}
            tone={last && last.fidelity >= 0.75 ? 'good' : undefined}
          />
          <Stat
            label="Primary accuracy"
            value={
              primary
                ? `${pct(primary.accuracy, 1)}${primary.lift === null ? '' : ` · ${primary.lift >= 0 ? '+' : ''}${(primary.lift * 100).toFixed(1)} vs baseline`}`
                : '—'
            }
          />
          <Stat label="Spend" value={usd(m.spendUsd)} />
          <Stat label="Last active" value={ago(m.updatedAt, now)} />
        </section>

        <section className="grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-lg font-medium">Fidelity over time</h2>
            <p className="mb-2 text-[13px] text-muted">
              After each scored answer, with its interval, beside the primary's and the baseline's accuracy.
            </p>
            <LineChart
              xLabel="Answers"
              yLabel="Fidelity"
              series={[
                {
                  name: 'Fidelity',
                  points: o.fidelity.map((f) => ({ x: f.seqUpTo, y: f.fidelity, lo: f.ciLow, hi: f.ciHigh })),
                },
                {
                  name: 'Accuracy',
                  points: o.fidelity.map((f) => ({ x: f.seqUpTo, y: f.acc })),
                },
                {
                  name: 'Baseline accuracy',
                  points: o.fidelity
                    .filter((f) => f.accBaseline !== null)
                    .map((f) => ({ x: f.seqUpTo, y: f.accBaseline! })),
                },
              ]}
            />
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-lg font-medium">Accuracy per predictor</h2>
              {hasShadows && (
                <Link
                  href={showShadows ? `/lab/mimics/${m.id}` : `/lab/mimics/${m.id}?shadows=1`}
                  className="text-[13px] text-muted hover:text-graphite hover:underline"
                >
                  {showShadows ? 'Hide shadows' : 'Show shadows'}
                </Link>
              )}
            </div>
            <p className="mb-2 text-[13px] text-muted">
              Item accuracy over the last {ROLLING_WINDOW} scored questions, by question number.
            </p>
            <LineChart
              xLabel="Question"
              yLabel="Item accuracy"
              series={curves.map((c) => ({
                name: `${c.role === 'shadow' ? '' : `${c.role} · `}${c.predictorId}`,
                points: c.points.map((p) => ({ x: p.seq, y: p.rolling })),
              }))}
            />
          </div>
        </section>

        <Section
          title="Predictors"
          note="This mimic only, on the questions each predictor answered. Lift is paired against the baseline."
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
              'Lift',
              'Failed',
              '$/1k',
              'p50',
              'p95',
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
              p.lift === null ? '—' : `${p.lift >= 0 ? '+' : ''}${(p.lift * 100).toFixed(1)}`,
              p.failures,
              usd(p.usdPer1k),
              ms(p.p50LatencyMs),
              ms(p.p95LatencyMs),
            ])}
          />
        </Section>

        <Section
          title="Questions"
          note="Served questions in order, with the person's answer and what the primary and the context-only baseline guessed beforehand. Questions the person's scope now hides stay hidden here."
        >
          {o.questions.length === 0 ? (
            <p className="text-[13px] text-muted">No questions served yet.</p>
          ) : (
            <ol className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-raised">
              {o.questions.map((q) => (
                <QuestionItem key={q.id} q={q} />
              ))}
            </ol>
          )}
        </Section>

        <Section
          title="Cost and latency per call type"
          note="Every model and search call logged for this mimic."
        >
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

        {o.siblings.length > 0 && (
          <Section title="This person's other mimics">
            <ul className="space-y-1 text-[14px]">
              {o.siblings.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/lab/mimics/${s.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {s.displayName}
                  </Link>{' '}
                  <span className="text-muted">
                    · {s.status} · {s.answers} answers · created {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </main>
    </div>
  );
}

function QuestionItem({ q }: { q: LabQuestionRow }) {
  return (
    <li className="grid gap-x-6 gap-y-2 px-4 py-3 text-[13px] md:grid-cols-[3rem_minmax(0,1fr)_minmax(0,18rem)]">
      <span className="tabular text-muted">#{q.seq}</span>
      <div className="min-w-0">
        {q.hidden ? (
          <p className="italic text-muted">Hidden by the person's scope.</p>
        ) : (
          <>
            <p className="text-[14px] text-graphite [text-wrap:pretty]">{q.prompt}</p>
            <p className="mt-1 text-[12px] text-muted">
              {q.kind} · {q.type} · {q.domain}
              {q.facetIds.length > 0 && <> · {q.facetIds.join(', ')}</>}
              {q.status !== 'answered' && <> · {q.status}</>}
            </p>
            {q.answer && (
              <p className="mt-1.5">
                <span className="text-muted">Answer </span>
                <span className="font-medium text-graphite">{q.answer.label}</span>
                <span className="text-muted tabular"> · {(q.answer.latencyMs / 1000).toFixed(1)} s</span>
                {q.answer.why && <span className="block text-muted">“{q.answer.why}”</span>}
              </p>
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 self-start tabular">
        {q.primary && (
          <>
            <dt className="text-muted">Primary</dt>
            <dd className="min-w-0">
              {q.primary.ok ? (
                <>
                  <span className="block [overflow-wrap:anywhere]">{q.hidden ? '—' : q.primary.label}</span>
                  <span className="text-muted">{pct(q.primary.p)}</span>{' '}
                  <span className={score(q.primary.itemAcc)}>
                    {q.primary.itemAcc === null ? '' : `· ${pct(q.primary.itemAcc)}`}
                  </span>
                  {q.primary.fallback && <span className="text-muted"> · fallback</span>}
                </>
              ) : (
                <span className="text-rust">failed</span>
              )}
            </dd>
          </>
        )}
        {q.baseline && (
          <>
            <dt className="text-muted">Baseline</dt>
            <dd className="min-w-0">
              <span className="block [overflow-wrap:anywhere]">{q.hidden ? '—' : q.baseline.label}</span>
              <span className="text-muted">{pct(q.baseline.p)}</span>{' '}
              <span className={score(q.baseline.itemAcc)}>
                {q.baseline.itemAcc === null ? '' : `· ${pct(q.baseline.itemAcc)}`}
              </span>
            </dd>
          </>
        )}
        {q.shadows > 0 && (
          <>
            <dt className="text-muted">Shadows</dt>
            <dd>{q.shadows}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
