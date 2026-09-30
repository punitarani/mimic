'use client';
import { createStore, del, entries, set } from 'idb-keyval';
import { type AnswerRequest, ApiError, api } from './api';

/**
 * Answer outbox (PLAN §8.2): answers are written to IndexedDB first with an idempotency key, then POSTed, and
 * retried on reconnect. The server enforces uniqueness on the key, so a retry never double-counts.
 */
export interface OutboxItem extends AnswerRequest {
  mimicId: string;
  createdAt: number;
}

const store = typeof indexedDB === 'undefined' ? undefined : createStore('mimic-outbox', 'answers');

export async function enqueueAnswer(item: OutboxItem): Promise<void> {
  if (store) await set(item.idempotencyKey, item, store);
}

export async function pendingAnswers(mimicId?: string): Promise<OutboxItem[]> {
  if (!store) return [];
  const all = (await entries<string, OutboxItem>(store)).map(([, v]) => v);
  return all.filter((a) => !mimicId || a.mimicId === mimicId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeAnswer(key: string): Promise<void> {
  if (store) await del(key, store);
}

/** Sends one queued answer; drops it on success or on a permanent (4xx) rejection. */
export async function sendAnswer(item: OutboxItem) {
  const { mimicId, createdAt: _c, ...body } = item;
  try {
    const res = await api.answer(mimicId, body);
    await removeAnswer(item.idempotencyKey);
    return res;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) {
      await removeAnswer(item.idempotencyKey);
    }
    throw e;
  }
}

/** Flushes every pending answer in order; stops at the first transient failure. Returns how many were sent. */
export async function flushOutbox(mimicId?: string): Promise<number> {
  let sent = 0;
  for (const item of await pendingAnswers(mimicId)) {
    try {
      await sendAnswer(item);
      sent++;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500 || e.status === 429 || e.status === 408) break;
    }
  }
  return sent;
}

export function newIdempotencyKey(): string {
  return `ans_${crypto.randomUUID()}`;
}
