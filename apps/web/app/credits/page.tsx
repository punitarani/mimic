import type { Metadata } from 'next';
import { TopBar } from '@/components/brand';
import sources from '@/lib/autocomplete-sources.json';

export const metadata: Metadata = { title: 'Credits · Mimic' };

/** The attribution the autocomplete data's licenses require (ADR-0030), kept off the intake form. */
export default function Credits() {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-6 sm:px-6">
        <h1 className="font-serif text-3xl tracking-tight">Credits</h1>
        <p className="mt-2 text-muted">The location and occupation suggestions use this data.</p>
        <ul className="mt-6 space-y-3 text-sm text-muted">
          {[...sources.places, ...sources.occupations].map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </main>
    </div>
  );
}
