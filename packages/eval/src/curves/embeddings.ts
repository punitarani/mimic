import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Gateway, sha256Hex } from '@mimic/core';
import type { Meter } from '../optimize/evaluate';
import type { TwinItem } from './data';

/**
 * Embeddings for the semantic policies (docs/CURVES.md §4), kept on disk by the text's hash like the decision cache:
 * a question's vector is fetched once, whatever run asks for it. Only the question (its prompt and option labels) is
 * embedded, never an answer.
 */

export const EMBED_BATCH = 64;

export const textOf = (it: Pick<TwinItem, 'prompt' | 'options'>) =>
  `${it.prompt} — ${it.options.map((o) => o.label).join(' / ')}`;

export async function embedTexts(
  gateway: Gateway,
  texts: readonly string[],
  opts: { dir: string; meter: Meter },
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const pathOf = (t: string) => {
    const h = sha256Hex(t);
    return join(opts.dir, h.slice(0, 2), `${h}.json`);
  };
  const missing: string[] = [];
  for (const t of new Set(texts)) {
    const p = pathOf(t);
    if (existsSync(p)) {
      try {
        const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
        if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
          out.set(t, v as number[]);
          continue;
        }
      } catch {
        // A torn file is a miss.
      }
    }
    missing.push(t);
  }
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    opts.meter.check();
    const batch = missing.slice(i, i + EMBED_BATCH);
    const r = await gateway.embed({ purpose: 'eval.curves.embed' }, batch);
    opts.meter.usd += r.usage.costUsd;
    batch.forEach((t, j) => {
      const v = r.vectors[j]!;
      out.set(t, v);
      const p = pathOf(t);
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(v));
      renameSync(tmp, p);
    });
  }
  return out;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
