import {
  buildState,
  DEFAULT_CONFIG,
  type EvidenceItem,
  type Option,
  type PersonState,
  type QType,
  type QuestionRecord,
  repeatAgreement,
  sha256Hex,
  stateOptions,
  unitHash,
} from '@mimic/core';
import { HELDOUT_PREFIX } from '../replay';
import { parseBlocks, readTwin } from '../twin';

/**
 * E9's data (docs/CURVES.md §3): Twin-2K-500 people in memory. A person's pool is every typed wave 1–3 answer (420 on
 * the full export), the items a policy may ask; their targets are the wave 4 items, split once by question into R
 * (questions a policy may read) and T (scored only); their retest answers are their own wave 1–3 answers to the
 * wave 4 questions, the ceiling.
 */

export const POOL_PREFIX = 'twin2k/w13/';

export interface TwinItem {
  key: string;
  qid: string;
  block: string;
  type: QType;
  prompt: string;
  options: Option[];
  answer: string;
}

export type Role = 'train' | 'dev' | 'test';
export type Half = 'R' | 'T';

export interface TwinPerson {
  pid: string;
  role: Role;
  /** Typed wave 1–3 items in survey order, minus any that match a wave 4 question. */
  pool: TwinItem[];
  /** Wave 4 items the policy may read (questions only) and the ones it is scored on. */
  reference: TwinItem[];
  targets: TwinItem[];
  /** Wave 4 item key → agreement of the person's wave 1–3 answer with their wave 4 answer (test–retest). */
  retest: Map<string, number>;
  /**
   * Answers every policy starts from (`--given`, docs/CURVES.md §4), as Mimic's identity step supplies some before the
   * first question: in the state ahead of anything asked and seen by the persona posterior, never in the pool, never
   * counted in k. Empty unless a run gives them.
   */
  given: TwinItem[];
}

/**
 * People are assigned once, by a hash of their Twin ID, never by file order or import: train (half) supplies the
 * population statistics some policies select with and is never scored; dev (three tenths) is for iteration; test (a
 * fifth) is read once, for the confirmatory run.
 */
export const ROLE_CUTS = { train: 0.5, dev: 0.8 } as const;

export function roleOf(pid: string): Role {
  const u = unitHash(`e9:people:${pid}`);
  return u < ROLE_CUTS.train ? 'train' : u < ROLE_CUTS.dev ? 'dev' : 'test';
}

/** Wave 4 questions are split by Qualtrics question (a matrix's rows stay together), the same for everyone. */
export function halfOf(qid: string): Half {
  return unitHash(`e9:rt:${qid}`) < 0.5 ? 'R' : 'T';
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const signature = (it: { prompt: string; options: Option[] }) =>
  `${norm(it.prompt)}|${it.options.map((o) => norm(o.label)).join('|')}`;

export interface LoadAudit {
  people: number;
  byRole: Record<Role, number>;
  /** Pool items dropped because they match a wave 4 question by signature or question ID, summed over people. */
  excludedBySignature: number;
  excludedByQid: number;
  meanPool: number;
  meanReference: number;
  meanTargets: number;
  meanRetest: number;
}

export interface LoadOptions {
  roles?: Role[];
  /** At most this many people per role, in a seeded order (`seed`). */
  limitPerRole?: Partial<Record<Role, number>>;
  /** Skip this many people of a role first, in the same order: people an earlier run already read. */
  offsetPerRole?: Partial<Record<Role, number>>;
  /** Skip the persona fields of people outside `roles` without parsing them. */
  seed?: string;
}

/** Strings repeat across 2,058 people; one copy each keeps the train population small in memory. */
class Interner {
  private readonly strings = new Map<string, string>();
  private readonly options = new Map<string, Option[]>();
  s(x: string): string {
    const hit = this.strings.get(x);
    if (hit !== undefined) return hit;
    this.strings.set(x, x);
    return x;
  }
  o(xs: Option[]): Option[] {
    const k = JSON.stringify(xs);
    const hit = this.options.get(k);
    if (hit) return hit;
    this.options.set(k, xs);
    return xs;
  }
}

/**
 * Reads the `wave_split` export (`readTwin`) into people. Pool items that match a wave 4 question are dropped, so no
 * policy can ask a target's own question (on the real export none do: the blocks are disjoint, and the audit shows
 * it).
 */
export async function loadPeople(
  path: string,
  opts: LoadOptions = {},
): Promise<{ people: TwinPerson[]; audit: LoadAudit }> {
  const roles = new Set<Role>(opts.roles ?? ['train', 'dev', 'test']);
  const intern = new Interner();
  const people: TwinPerson[] = [];
  let bySignature = 0;
  let byQid = 0;
  for await (const line of readTwin(path)) {
    const role = roleOf(line.pid);
    if (!roles.has(role)) continue;
    const held = parseBlocks(line.wave4_Q_wave4_A, HELDOUT_PREFIX);
    if (!held.length) continue;
    const retestItems = line.wave4_Q_wave1_3_A ? parseBlocks(line.wave4_Q_wave1_3_A, HELDOUT_PREFIX) : [];
    const heldSigs = new Set([...held, ...retestItems].map(signature));
    const heldQids = new Set([...held, ...retestItems].map((i) => i.qid));
    const pool: TwinItem[] = [];
    for (const it of parseBlocks(line.wave1_3_persona_json, POOL_PREFIX)) {
      if (heldSigs.has(signature(it))) {
        bySignature++;
        continue;
      }
      if (heldQids.has(it.qid)) {
        byQid++;
        continue;
      }
      pool.push(item(it, intern));
    }
    const answers = new Map(held.map((h) => [h.itemKey, h]));
    const retest = new Map<string, number>();
    for (const r of retestItems) {
      const h = answers.get(r.itemKey);
      if (h && h.type === r.type) retest.set(r.itemKey, repeatAgreement(h.type, h.answer, r.answer));
    }
    const reference: TwinItem[] = [];
    const targets: TwinItem[] = [];
    for (const h of held) (halfOf(h.qid ?? h.itemKey) === 'R' ? reference : targets).push(item(h, intern));
    people.push({ pid: line.pid, role, pool, reference, targets, retest, given: [] });
  }
  const limited = limitPeople(people, opts);
  const byRole: Record<Role, number> = { train: 0, dev: 0, test: 0 };
  for (const p of limited) byRole[p.role]++;
  const avg = (f: (p: TwinPerson) => number) =>
    limited.length ? limited.reduce((a, p) => a + f(p), 0) / limited.length : 0;
  return {
    people: limited,
    audit: {
      people: limited.length,
      byRole,
      excludedBySignature: bySignature,
      excludedByQid: byQid,
      meanPool: avg((p) => p.pool.length),
      meanReference: avg((p) => p.reference.length),
      meanTargets: avg((p) => p.targets.length),
      meanRetest: avg((p) => p.retest.size),
    },
  };
}

function item(
  it: {
    itemKey: string;
    qid?: string;
    block?: string;
    type: QType;
    prompt: string;
    options: Option[];
    answer: string;
  },
  intern: Interner,
): TwinItem {
  return {
    key: intern.s(it.itemKey),
    qid: intern.s(it.qid ?? it.itemKey),
    block: intern.s(it.block ?? ''),
    type: it.type,
    // As the importer stores it, so states match E6's and E8's for the same answers.
    prompt: intern.s(it.prompt.slice(0, 1000)),
    options: intern.o(it.options),
    answer: it.answer,
  };
}

/** Each role in a seeded order (by hash of seed and ID), cut to its limit. */
function limitPeople(people: TwinPerson[], opts: LoadOptions): TwinPerson[] {
  const seed = opts.seed ?? 'e9';
  const out: TwinPerson[] = [];
  for (const role of ['train', 'dev', 'test'] as const) {
    const mine = people
      .filter((p) => p.role === role)
      .sort((a, b) => unitHash(`${seed}:order:${a.pid}`) - unitHash(`${seed}:order:${b.pid}`));
    const from = opts.offsetPerRole?.[role] ?? 0;
    out.push(...mine.slice(from, from + (opts.limitPerRole?.[role] ?? mine.length)));
  }
  return out;
}

/** A stable question ID per item and prompt, so the same question in any state is the same request key. */
export function questionIdOf(it: Pick<TwinItem, 'key' | 'prompt'>): string {
  return `e9_${sha256Hex(`${it.key}|${it.prompt}`).slice(0, 16)}`;
}

export function questionOf(it: TwinItem, mimicId: string, seq: number): QuestionRecord {
  return {
    id: questionIdOf(it),
    mimicId,
    seq,
    kind: 'adaptive',
    type: it.type,
    domain: 'core',
    prompt: it.prompt,
    options: it.options,
    facetIds: [],
    itemKey: it.key,
    provenance: { generator: 'twin2k500', configHash: 'e9', promptVersion: 'twin2k500.v1' },
    status: 'served',
    quality: null,
    createdAt: 0,
    servedAt: 0,
    stateAt: 0,
  };
}

export const mimicIdOf = (pid: string) => `twin2k:${pid}`;

/**
 * The sealed state after `asked`, in the order asked: the importer's identity and the default builder (`full`, latency
 * hints) with a budget that fits every answer, so nothing is trimmed and the state for the first k survey answers is
 * the one E6 and E8 sent. `beforeSeq` seals it (invariant 1): only answers with seq < k + 1 enter.
 */
export const STATE_BUDGET_TOKENS = 24_000;

/** The sealed state after a person's given answers and then the first `asked`. */
export function stateOf(person: Pick<TwinPerson, 'pid' | 'given'>, asked: readonly TwinItem[]): PersonState {
  return stateAfter(person.pid, person.given.length ? [...person.given, ...asked] : asked);
}

/**
 * Moves pool items into `given`, in survey order. A token names a block (every item in it); one prefixed with `-` is
 * a QID left in the pool: `Demographics,-QID20` gives the demographics except party.
 */
export function withGiven(people: readonly TwinPerson[], spec: string): TwinPerson[] {
  const isGiven = itemMatcher(spec);
  return people.map((p) => ({
    ...p,
    given: [...p.given, ...p.pool.filter(isGiven)],
    pool: p.pool.filter((i) => !isGiven(i)),
  }));
}

/**
 * Removes pool items from everyone (`--drop`): items Mimic never asks early, as its trust ramp holds sensitive ones
 * back. A token names a block or a QID (`QID20,QID21`); one prefixed with `-` keeps a QID of a named block. A dropped
 * item is never asked, given or planned; the population statistics still hold the train people's answers to it.
 */
export function withoutItems(people: readonly TwinPerson[], spec: string): TwinPerson[] {
  const drop = itemMatcher(spec, true);
  return people.map((p) => ({ ...p, pool: p.pool.filter((i) => !drop(i)) }));
}

/** The item's QID as the key spells it (`twin2k/w13/QID25/36` → `QID25`). */
const qidOf = (i: TwinItem) => i.key.split('/')[2] ?? i.qid;

function itemMatcher(spec: string, byQid = false): (i: TwinItem) => boolean {
  const tokens = spec
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const named = new Set(tokens.filter((t) => !t.startsWith('-')));
  const keep = new Set(tokens.filter((t) => t.startsWith('-')).map((t) => t.slice(1)));
  return (i) => (named.has(i.block) || (byQid && named.has(qidOf(i)))) && !keep.has(qidOf(i));
}

export function stateAfter(pid: string, asked: readonly TwinItem[]): PersonState {
  const evidence: EvidenceItem[] = asked.map((it, i) => ({
    seq: i + 1,
    questionId: questionIdOf(it),
    kind: 'adaptive',
    type: it.type,
    prompt: it.prompt,
    options: it.options,
    answer: it.answer,
    facetIds: [],
    latencyMs: 0,
  }));
  const state = buildState(
    {
      mimicId: mimicIdOf(pid),
      identity: { displayName: 'Participant', location: 'United States' },
      facts: [],
      evidence,
      traits: [],
      insights: [],
    },
    stateOptions(DEFAULT_CONFIG, asked.length + 1, { budgetTokens: STATE_BUDGET_TOKENS }),
  );
  if (state.evidence.length !== asked.length)
    throw new Error(`state for ${pid} kept ${state.evidence.length} of ${asked.length} answers`);
  return state;
}
