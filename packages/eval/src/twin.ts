import { readFileSync } from 'node:fs';
import {
  DEFAULT_SCOPE,
  type EngineDeps,
  ensureDefaultConfig,
  type MimicRecord,
  type Option,
  type QType,
  type QuestionRecord,
  splitFor,
} from '@mimic/core';
import { z } from 'zod';
import { HELDOUT_PREFIX } from './replay';

/**
 * Twin-2K-500 importer (PLAN §12.5; Toubia et al. 2025, CC BY 4.0). Input: JSON Lines with one participant per line,
 * fields `pid`, `wave1_3_persona_json`, `wave4_Q_wave4_A` and optionally `wave4_Q_wave1_3_A` (the `wave_split`
 * config). Convert the Hugging Face parquet once with:
 *
 *   python -c "import datasets; datasets.load_dataset('LLM-Digital-Twin/Twin-2K-500','wave_split')['data']
 *     .to_json('twin2k500.jsonl')"
 *
 * Only items that map onto our typed primitives are imported: single-choice MC with 2–5 options (yes/no → noul) and
 * Matrix rows with 2–5 columns (5 ordered columns → score). Wave 1–3 answers become evidence; wave 4 answers become
 * held-out items; wave 1–3 answers to wave 4 questions become repeat pairs (test-retest self-consistency).
 */

interface TwinQuestion {
  QuestionID?: string;
  QuestionText?: string;
  QuestionType?: string;
  Options?: string[];
  Rows?: string[];
  Columns?: string[];
  Settings?: { Selector?: string };
  Answers?: { SelectedByPosition?: number | number[] | null; SelectedText?: unknown };
}

interface TwinElement {
  ElementType?: string;
  Questions?: TwinQuestion[];
  Elements?: TwinElement[];
}

export interface TypedItem {
  itemKey: string;
  type: QType;
  prompt: string;
  options: Option[];
  answer: string;
}

const Line = z.object({
  pid: z.union([z.string(), z.number()]).transform(String),
  wave1_3_persona_json: z.string(),
  wave4_Q_wave4_A: z.string(),
  wave4_Q_wave1_3_A: z.string().optional(),
});

function strip(html: string | undefined): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionsOf(elements: TwinElement[]): TwinQuestion[] {
  const out: TwinQuestion[] = [];
  for (const e of elements) {
    if (e.ElementType === 'Block') out.push(...(e.Questions ?? []));
    else if (e.ElementType === 'Branch') out.push(...questionsOf(e.Elements ?? []));
  }
  return out;
}

const YES_NO = /^(yes|no)$/i;

function typedOptions(labels: string[], ordered: boolean): { type: QType; options: Option[] } | null {
  const clean = labels.map(strip).filter(Boolean);
  if (clean.length < 2 || clean.length > 5 || clean.length !== labels.length) return null;
  if (clean.length === 2 && clean.every((l) => YES_NO.test(l))) {
    return {
      type: 'noul',
      options: [
        { key: 'yes', label: 'Yes' },
        { key: 'no', label: 'No' },
      ],
    };
  }
  if (ordered && clean.length === 5)
    return { type: 'score', options: clean.map((label, i) => ({ key: String(i), label })) };
  return { type: 'choice', options: clean.map((label, i) => ({ key: 'abcde'[i]!, label })) };
}

function keyForPosition(t: { type: QType; options: Option[] }, labels: string[], pos: number): string | null {
  if (!Number.isInteger(pos) || pos < 1 || pos > labels.length) return null;
  if (t.type === 'noul') return /^yes$/i.test(strip(labels[pos - 1])) ? 'yes' : 'no';
  return t.options[pos - 1]!.key;
}

/** Maps one Twin question onto zero or more typed items with answers. */
export function toTypedItems(q: TwinQuestion, prefix: string): TypedItem[] {
  const id = q.QuestionID;
  if (!id) return [];
  const text = strip(q.QuestionText);
  if (q.QuestionType === 'MC') {
    const sel = q.Settings?.Selector;
    if (sel !== 'SAVR' && sel !== 'SAHR') return [];
    const labels = q.Options ?? [];
    const t = typedOptions(labels, false);
    const pos = q.Answers?.SelectedByPosition;
    if (!t || typeof pos !== 'number' || !text) return [];
    const answer = keyForPosition(t, labels, pos);
    return answer
      ? [{ itemKey: `${prefix}${id}`, type: t.type, prompt: text, options: t.options, answer }]
      : [];
  }
  if (q.QuestionType === 'Matrix') {
    const cols = q.Columns ?? [];
    const t = typedOptions(cols, true);
    const positions = q.Answers?.SelectedByPosition;
    if (!t || !Array.isArray(positions)) return [];
    const items: TypedItem[] = [];
    (q.Rows ?? []).forEach((row, i) => {
      const pos = positions[i];
      if (typeof pos !== 'number') return;
      const answer = keyForPosition(t, cols, pos);
      const rowText = strip(row);
      if (!answer || !rowText) return;
      items.push({
        itemKey: `${prefix}${id}/${i + 1}`,
        type: t.type,
        prompt: text ? `${text} — ${rowText}` : rowText,
        options: t.options,
        answer,
      });
    });
    return items;
  }
  return [];
}

export function parseBlocks(json: string, prefix: string): TypedItem[] {
  const parsed = JSON.parse(json) as TwinElement[] | TwinElement;
  const elements = Array.isArray(parsed) ? parsed : [parsed];
  return questionsOf(elements).flatMap((q) => toTypedItems(q, prefix));
}

export interface ImportOptions {
  path: string;
  limit?: number;
  /** Cap wave 1–3 evidence per person (the state builder budgets it anyway). */
  maxEvidence?: number;
}

/** Imports Twin-2K-500 participants as research-consented mimics with typed evidence, held-out and repeat items. */
export async function importTwin(
  deps: EngineDeps,
  opts: ImportOptions,
): Promise<{ people: number; items: number }> {
  const cfgHash = await ensureDefaultConfig(deps);
  const lines = readFileSync(opts.path, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  let people = 0;
  let items = 0;
  for (const raw of lines.slice(0, opts.limit ?? lines.length)) {
    const line = Line.parse(JSON.parse(raw));
    const evidence = parseBlocks(line.wave1_3_persona_json, 'twin2k/w13/').slice(0, opts.maxEvidence ?? 400);
    const heldout = parseBlocks(line.wave4_Q_wave4_A, HELDOUT_PREFIX);
    const retest = line.wave4_Q_wave1_3_A ? parseBlocks(line.wave4_Q_wave1_3_A, HELDOUT_PREFIX) : [];
    if (!evidence.length || !heldout.length) continue;
    const now = deps.clock();
    const id = deps.newId();
    const m: MimicRecord = {
      id,
      participantId: `twin2k:${line.pid}`,
      displayName: 'Participant',
      location: 'United States',
      occupation: null,
      employer: null,
      links: [],
      status: 'learning',
      identityState: 'skipped',
      configHash: cfgHash,
      experimentId: null,
      arm: 'twin2k500',
      consentApp: true,
      consentSearch: false,
      consentResearch: true,
      scope: DEFAULT_SCOPE,
      scopeAt: null,
      split: splitFor(id),
      seqMax: 0,
      evidenceEpoch: 0,
      snapshotVersion: 0,
      spendUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    await deps.store.ensureParticipant(m.participantId, now);
    await deps.store.insertMimic(m);
    let seq = 0;
    const questions: QuestionRecord[] = [];
    const answers: Array<{ q: QuestionRecord; value: string }> = [];
    const add = (it: TypedItem, kind: 'adaptive' | 'repeat', repeatOf?: string) => {
      seq++;
      const q: QuestionRecord = {
        id: deps.newId(),
        mimicId: id,
        seq,
        kind,
        type: it.type,
        domain: 'core',
        prompt: it.prompt.slice(0, 1000),
        options: it.options,
        facetIds: [],
        itemKey: it.itemKey,
        provenance: { generator: 'twin2k500', configHash: cfgHash, promptVersion: 'twin2k500.v1' },
        // Served, like a session question; recordAnswer marks it answered (it only records onto a served question).
        status: 'served',
        quality: null,
        createdAt: now + seq,
        servedAt: now + seq,
        stateAt: now + seq,
        ...(repeatOf ? { repeatOf } : {}),
      };
      questions.push(q);
      answers.push({ q, value: it.answer });
      return q;
    };
    for (const it of evidence) add(it, 'adaptive');
    const heldoutIds = new Map<string, string>();
    for (const it of heldout) heldoutIds.set(it.itemKey, add(it, 'adaptive').id);
    for (const it of retest) {
      const target = heldoutIds.get(it.itemKey);
      if (target) add(it, 'repeat', target);
    }
    await deps.store.insertQuestions(questions);
    for (const { q, value } of answers) {
      const recorded = await deps.store.recordAnswer({
        answer: {
          id: deps.newId(),
          questionId: q.id,
          mimicId: id,
          seq: q.seq!,
          value,
          why: null,
          latencyMs: 0,
          revealedPrediction: false,
          idempotencyKey: `twin2k:${line.pid}:${q.seq}`,
          createdAt: now + q.seq!,
        },
        scores: [],
      });
      if (!recorded) throw new Error(`Could not record ${line.pid} seq ${q.seq}`);
    }
    await deps.store.updateMimic(id, { seqMax: seq });
    people++;
    items += questions.length;
  }
  return { people, items };
}
