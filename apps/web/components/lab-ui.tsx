import type { Population } from '@mimic/core';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Server-renderable building blocks shared by the /lab pages. */

/** How /lab names each population (ADR-0045): scripted and imported people are always labelled as such. */
export const POPULATION_LABEL: Record<Population | 'all', string> = {
  all: 'Everyone',
  real: 'Real people',
  scripted: 'Scripted',
  twin2k: 'Twin-2K-500',
};

export const pct = (x: number | null | undefined, d = 0) =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`;
export const num = (x: number, d = 3) => x.toFixed(d);
export const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
export const ms = (x: number) => `${Math.round(x)} ms`;

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600 * 1000],
  ['month', 30 * 24 * 3600 * 1000],
  ['week', 7 * 24 * 3600 * 1000],
  ['day', 24 * 3600 * 1000],
  ['hour', 3600 * 1000],
  ['minute', 60 * 1000],
];

/** "3 days ago"; "just now" under a minute. */
export function ago(t: number, now: number): string {
  const diff = t - now;
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS)
    if (Math.abs(diff) >= size) return fmt.format(Math.round(diff / size), unit);
  return 'just now';
}

const TABS = [
  { href: '/lab', label: 'Overview' },
  { href: '/lab/mimics', label: 'People' },
] as const;

/** The /lab section switcher, under the page title. */
export function LabNav({ active }: { active: (typeof TABS)[number]['href'] }) {
  return (
    <nav aria-label="Lab sections" className="flex gap-1 border-b border-line text-[14px]">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === active ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 ${
            t.href === active
              ? 'border-graphite text-graphite'
              : 'border-transparent text-muted hover:text-graphite'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Chip({ href, on, children }: { href: string; on: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'true' : undefined}
      className={`rounded-full border px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 ${
        on ? 'border-graphite text-graphite' : 'border-line text-muted hover:text-graphite'
      }`}
    >
      {children}
    </Link>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'bad';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'border-line text-muted',
    good: 'border-moss/40 text-moss',
    bad: 'border-rust/40 text-rust',
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
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

export function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-medium">{title}</h2>
      {note && <p className="text-[13px] text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
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
