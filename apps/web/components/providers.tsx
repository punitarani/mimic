'use client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createStore, del, get, set } from 'idb-keyval';
import { type ReactNode, useEffect, useState } from 'react';
import { flushOutbox } from '@/lib/outbox';

/**
 * TanStack Query persisted to IndexedDB (PLAN §8.2): render from cache immediately, then revalidate. Only the
 * queries that are safe to show stale are persisted (mimic list, UI snapshot, current question).
 */
const PERSISTED = new Set(['mimics', 'snapshot', 'question']);

function idbStorage() {
  if (typeof indexedDB === 'undefined') return undefined;
  const store = createStore('mimic-cache', 'queries');
  return {
    getItem: (k: string) => get<string>(k, store).then((v) => v ?? null),
    setItem: (k: string, v: string) => set(k, v, store),
    removeItem: (k: string) => del(k, store),
  };
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, gcTime: 24 * 3600 * 1000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  // On the server (no IndexedDB) the persister is a no-op; the provider is always rendered.
  const [persister] = useState(() =>
    createAsyncStoragePersister({ storage: idbStorage(), key: 'mimic-query-cache', throttleTime: 500 }),
  );

  // Retry queued answers on reconnect.
  useEffect(() => {
    const onOnline = () => {
      void flushOutbox().then((n) => {
        if (n > 0) void client.invalidateQueries();
      });
    };
    window.addEventListener('online', onOnline);
    onOnline();
    return () => window.removeEventListener('online', onOnline);
  }, [client]);

  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 3600 * 1000,
        // v2: the snapshot carries the person's scope (ADR-0043); older cached snapshots don't.
        buster: 'v2',
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === 'success' && PERSISTED.has(String(q.queryKey[0])),
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
