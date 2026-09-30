import Link from 'next/link';
import { TopBar } from '@/components/brand';
import { buttonClass } from '@/components/button-styles';
import { INVITE_PARAM, inviteFromQuery, newMimicHref } from '@/lib/invite';
import { currentParticipant, deps } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [INVITE_PARAM]?: string | string[] }>;
}) {
  const [{ deps: d, env }, sp] = await Promise.all([deps(), searchParams]);
  const pid = await currentParticipant(env);
  const mimics = pid ? await d.store.listMimics({ participantId: pid }) : [];
  // An invite link can point at the landing page too; the code rides along to the intake form.
  const invite = inviteFromQuery(sp[INVITE_PARAM]);
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-16 sm:px-6">
        <h1 className="prompt max-w-2xl text-graphite">
          Answer a few quick questions, and Mimic learns to predict how you decide.
        </h1>
        <div className="mt-8">
          <Link href={newMimicHref(invite)} className={buttonClass('primary', 'lg')}>
            Build your mimic
          </Link>
        </div>
        {mimics.length > 0 && (
          <section className="mt-16" aria-labelledby="yours">
            <h2 id="yours" className="text-sm font-medium text-muted">
              Your mimics
            </h2>
            <ul className="mt-3 divide-y divide-line rounded-[var(--radius-card)] border border-line bg-raised">
              {mimics.map((m) => (
                <li key={m.id}>
                  <Link
                    href={m.status === 'identity' ? `/m/${m.id}/identity` : `/m/${m.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-surface"
                  >
                    <span className="font-medium">{m.displayName}</span>
                    <span className="text-sm text-muted">
                      {new Date(m.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 text-[13px] text-muted sm:px-6">
        You can only build a mimic of yourself. You can download or delete it at any time.{' '}
        <Link href="/credits" className="underline underline-offset-2 hover:text-graphite">
          Credits
        </Link>
      </footer>
    </div>
  );
}
