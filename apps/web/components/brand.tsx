import Link from 'next/link';

/** Small version of the signature element: two overlapping circles, "You" and "Mimic". */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="12" r="7" fill="var(--color-graphite)" fillOpacity="0.85" />
      <circle cx="15" cy="12" r="7" fill="var(--color-ink)" fillOpacity="0.7" />
    </svg>
  );
}

export function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
      <Link
        href="/"
        className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-graphite"
      >
        <Mark />
        Mimic
      </Link>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

/** The link to `/credits`, the attribution the autocomplete data's licenses require (ADR-0030). */
export function CreditsLink() {
  return (
    <Link href="/credits" className="underline underline-offset-2 hover:text-graphite">
      Credits
    </Link>
  );
}
