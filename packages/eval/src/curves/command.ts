import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type EvalRunRecord, type Gateway, seededRng, sha256Hex, ulid } from '@mimic/core';
import { CachingGateway } from '../decision-cache';
import { openLocalEngine } from '../local';
import { DECISION_TIMEOUT_MS } from '../models';
import { positive } from '../optimize/commands';
import {
  BudgetStop,
  type EvalRecord,
  evaluateCandidate,
  Meter,
  mapLimit,
  predictorFor,
  resolveCandidate,
  toRecord,
} from '../optimize/evaluate';
import type { EvalInstance } from '../optimize/instances';
import { renderReport, writeReport } from '../report';
import { analyzeCurves, type CurveRecord, type CurvesReport, renderCurves } from './analyze';
import { type ClassModel, ClassPosterior, classKeys, fitClasses } from './classes';
import {
  type LoadAudit,
  loadPeople,
  mimicIdOf,
  questionOf,
  type Role,
  stateOf,
  type TwinItem,
  type TwinPerson,
  withGiven,
  withoutItems,
} from './data';
import { embedTexts, textOf } from './embeddings';
import { jevLift, type LiftRow } from './lift';
import {
  anchorOrder,
  hybridPolicy,
  JevOracle,
  jevEigPolicy,
  jevEntropyPolicy,
  needsEmbeddings,
  needsJev,
  needsPopulation,
  openedPolicy,
  openingKeys,
  orderPolicy,
  POLICY_DEFAULTS,
  POLICY_NAMES,
  type Policy,
  type PolicyKnobs,
  type PolicyName,
  parsePolicySpec,
  popEigPolicy,
  popEntropyPolicy,
  popStaticPolicy,
  popTransferPolicy,
  randomPolicy,
  semRefPolicy,
  stratifiedPolicy,
  TWIN_ANCHORS,
} from './policies';
import { PersonaPosterior, POPULATION_DEFAULTS, Population, staticSequence } from './population';

export type { CurvesReport };
export { renderCurves };

export const JEV_PREDICTOR = 'decision:typesafe/jev-1.13';
export const DEFAULT_CHECKPOINTS = [0, 3, 6, 10, 15, 20, 25, 30];
export const DEFAULT_POLICIES: PolicyName[] = [...POLICY_NAMES];

export interface CurvesDeps {
  gateway: Gateway;
  meter: Meter;
}

/** One person under one policy: the items asked, one at a time, each answer revealed after it is chosen. */
export async function walk(
  person: TwinPerson,
  policy: Policy,
  steps: number,
  ctx: {
    jev: JevOracle;
    pop: Population | null;
    seed: string;
    /** Filled with each step's selection score (null when the policy has none). */
    scores?: Array<number | null>;
    vectors?: ReadonlyMap<string, number[]>;
  },
): Promise<TwinItem[]> {
  const rng = seededRng(`${ctx.seed}:${policy.name}:${person.pid}`);
  const asked: TwinItem[] = [];
  let remaining = [...person.pool];
  const posterior =
    policy.usesPopulation && ctx.pop
      ? (policy.posteriorOf?.() ?? new PersonaPosterior(ctx.pop, undefined, policy.beta ?? 1))
      : null;
  if (posterior) for (const g of person.given) posterior.observe(g.key, posterior.indexOf(g));
  for (let t = 0; t < Math.min(steps, person.pool.length); t++) {
    let score: number | null = null;
    const item = await policy.next({
      person,
      asked,
      remaining,
      state: stateOf(person, asked),
      rng,
      jev: ctx.jev,
      pop: ctx.pop,
      posterior,
      note: (x) => {
        score = x;
      },
      ...(ctx.vectors ? { vectors: ctx.vectors } : {}),
    });
    ctx.scores?.push(score);
    if (!remaining.includes(item)) throw new Error(`${policy.name} picked ${item.key}, not in the pool`);
    asked.push(item);
    remaining = remaining.filter((i) => i !== item);
    if (posterior) posterior.observe(item.key, posterior.indexOf(item));
  }
  return asked;
}

/**
 * The persona posterior as a reader: after the first k asked answers, its predictive distribution for each target,
 * from the train people who answered alike. It measures what the asked answers say about the targets, apart from how
 * well Jev reads them. Cross-person data, so a yardstick only (ADR-0071), never a predictor Mimic serves.
 */
export function populationReader(
  pop: Population,
  person: TwinPerson,
  asked: readonly TwinItem[],
  checkpoints: readonly number[],
  policy: string,
  beta = 1,
): CurveRecord[] {
  const post = new PersonaPosterior(pop, undefined, beta);
  for (const g of person.given) post.observe(g.key, pop.indexOf(g));
  const out: CurveRecord[] = [];
  let seen = 0;
  for (const k of [...checkpoints].sort((a, b) => a - b)) {
    for (; seen < Math.min(k, asked.length); seen++)
      post.observe(asked[seen]!.key, pop.indexOf(asked[seen]!));
    const w = post.weights();
    for (const inst of targetInstances(person, asked, k)) {
      const it = person.targets.find((t) => t.key === inst.question.itemKey)!;
      const p = post.predictive(it.key, w);
      const keys = it.options.map((o) => o.key);
      const dist = Object.fromEntries(
        keys.map((key, i) => [key, p && i < p.length ? p[i]! : 1 / keys.length]),
      );
      const z = Object.values(dist).reduce((a, b) => a + b, 0);
      for (const key of keys) dist[key] = dist[key]! / z;
      out.push({
        policy,
        k,
        block: it.block,
        rec: toRecord(inst, 'population', 'population', {
          dist,
          ok: true,
          costUsd: 0,
          latencyMs: 0,
          modelSnapshot: 'population',
        }),
      });
    }
  }
  return out;
}

/** The scored instances for one person after the first k asked: every target T from the sealed state. */
export function targetInstances(person: TwinPerson, asked: readonly TwinItem[], k: number): EvalInstance[] {
  const mimicId = mimicIdOf(person.pid);
  const state = stateOf(person, asked.slice(0, k));
  return person.targets.map((it, i) => ({
    id: `${mimicId}|${k}|${it.key}`,
    mimicId,
    split: person.role === 'test' ? 'test' : 'dev',
    mode: 'heldout',
    population: 'twin2k',
    questionId: questionOf(it, mimicId, k + 1 + i).id,
    seq: k + 1 + i,
    k,
    question: questionOf(it, mimicId, k + 1 + i),
    answer: it.answer,
    why: null,
    revealed: false,
    state,
    baseline: null,
    repeatAgreement: person.retest.get(it.key) ?? null,
    stored: [],
    identityTerms: [],
  }));
}

function basePolicy(
  base: PolicyName,
  knobs: PolicyKnobs,
  seed: string,
  staticSeq: readonly string[] | null,
  liftSeq?: readonly string[],
): Policy {
  switch (base) {
    case 'order':
      return orderPolicy;
    case 'random':
      return randomPolicy;
    case 'stratified':
      return stratifiedPolicy;
    case 'jev-entropy':
      return jevEntropyPolicy(knobs);
    case 'pop-eig':
      return popEigPolicy(knobs, seed);
    case 'pop-static':
      if (!staticSeq) throw new Error('pop-static needs a static sequence');
      return popStaticPolicy(staticSeq);
    case 'jev-eig':
      return jevEigPolicy(knobs, seed);
    case 'hybrid':
      return hybridPolicy(knobs, seed);
    case 'pop-entropy':
      return popEntropyPolicy;
    case 'pop-transfer':
      return popTransferPolicy(knobs, seed);
    case 'sem-ref':
      return semRefPolicy(knobs);
    case 'jev-lift':
      if (!liftSeq) throw new Error("jev-lift needs Jev's lift table (the run measures it on train people)");
      return { ...popStaticPolicy(liftSeq), name: 'jev-lift' };
  }
}

/** What some policies need beyond their spec, measured or fitted once per run. */
export interface PolicyExtras {
  /** The latent-class model with k classes (`cls=k`), fitted once on the train people. */
  classesOf?: (k: number) => ClassModel;
  /** The run's `--opening` sequence, for `custom-…` policies. */
  custom?: readonly string[];
  /** Candidates by Jev's lift, most helpful first (`jev-lift`). */
  liftSeq?: readonly string[];
}

/** Policies from their specs (`parsePolicySpec`), each named by its spec. */
export function buildPolicies(
  specs: readonly string[],
  knobs: PolicyKnobs,
  seed: string,
  staticSeq: readonly string[] | null,
  extras: PolicyExtras = {},
): Policy[] {
  const { classesOf, custom, liftSeq } = extras;
  return specs.map((raw) => {
    const s = parsePolicySpec(raw);
    const own = { ...knobs, ...s.knobs };
    const base = basePolicy(s.base, own, seed, staticSeq, liftSeq);
    let inner = base;
    if (own.classes > 0) {
      if (!base.usesPopulation) throw new Error(`${s.spec}: cls is for the persona posterior's policies`);
      if (!classesOf) throw new Error(`${s.spec} needs the train people's classes`);
      const model = classesOf(own.classes);
      inner = { ...base, posteriorOf: () => new ClassPosterior(model, own.beta) };
    }
    if (s.open > 0 && s.opening === 'anchors') return openedPolicy(s.spec, s.open, anchorOrder(seed), inner);
    if (s.open > 0 && s.opening === 'custom') {
      if (!custom?.length) throw new Error(`${s.spec} needs --opening`);
      return openedPolicy(s.spec, s.open, custom, inner);
    }
    if (s.open > 0) {
      if (!staticSeq) throw new Error(`${s.spec} needs the static questionnaire`);
      return openedPolicy(s.spec, s.open, staticSeq, inner);
    }
    return { ...inner, name: s.spec };
  });
}

export interface RunOptions {
  people: TwinPerson[];
  train: TwinPerson[];
  policies: string[];
  /** Item keys `custom-…` policies open with (`--opening`). */
  opening?: string[];
  checkpoints: number[];
  knobs: PolicyKnobs;
  seed: string;
  /** People run at once. */
  concurrency: number;
  /** People per chunk: a budget stop drops the chunk for every policy, so the arms stay paired. */
  chunkPeople: number;
  /**
   * Score with the population reader instead of Jev, and refuse policies that need Jev: no model calls at all, for
   * iterating on the population policies (a yardstick, never a result about Jev).
   */
  noJev?: boolean;
  /** A chunk whose predictions fail above this rate is an outage: dropped for every policy, and the run stops. */
  maxFailureRate?: number;
  /** Where the semantic policies' embeddings are kept (`embedTexts`). */
  embedDir?: string;
}

export interface RunResult {
  records: CurveRecord[];
  /** The population reader's predictions of the same targets from the same asked answers (no model calls). */
  reader: CurveRecord[];
  trajectories: Map<string, Map<string, TwinItem[]>>;
  /** Policy → person → each step's selection score (null where the policy has none). */
  scores: Map<string, Map<string, Array<number | null>>>;
  costs: Record<string, { selection: number; scoring: number; requests: number }>;
  stopReason: string | null;
  staticSequence: string[] | null;
  /** Jev's lift per candidate (`jev-lift`), most helpful first; null when no policy measured it. */
  lift: LiftRow[] | null;
}

/** Runs every policy on every person, chunk by chunk, then scores the targets at each checkpoint. */
export async function runCurves(deps: CurvesDeps, opts: RunOptions): Promise<RunResult> {
  const specs = opts.policies.map(parsePolicySpec);
  // The population serves the policies that select with it and, whenever there are train people, the population
  // reader (what the asked answers say about the targets without Jev).
  const pop =
    specs.some(needsPopulation) || opts.train.length ? new Population(opts.train, POPULATION_DEFAULTS) : null;
  const refKeys = [...new Set(opts.train.flatMap((p) => p.reference.map((r) => r.key)))];
  const staticSeq =
    pop && specs.some((s) => s.base === 'pop-static' || s.open > 0)
      ? staticSequence(pop, opts.train, refKeys, {
          steps: Math.max(...opts.checkpoints),
          probes: opts.knobs.staticProbes,
          seed: opts.seed,
          // Planned with the posterior the run reads with (`--beta`); 1 reproduces round 1's sequence.
          beta: opts.knobs.beta,
        })
      : null;
  const fitted = new Map<number, ClassModel>();
  const classesOf = (k: number) => {
    if (!pop) throw new Error('classes need train people');
    let m = fitted.get(k);
    if (!m) {
      m = fitClasses(pop, classKeys(opts.train), { k, seed: opts.seed });
      fitted.set(k, m);
      console.log(
        `classes: ${k} fitted on ${opts.train.length} train people, mean log likelihood ${m.logLik.toFixed(2)}`,
      );
    }
    return m;
  };
  const candidate = resolveCandidate({ predictor: JEV_PREDICTOR });
  // jev-lift: Jev's lift for the top candidates by population transfer (plus production's anchors), measured once on
  // train people before anyone is walked; its cost is the policy's selection cost.
  let lift: LiftRow[] | null = null;
  let liftUsd = 0;
  const liftSpec = specs.find((s) => s.base === 'jev-lift');
  if (liftSpec && pop) {
    const own = { ...opts.knobs, ...liftSpec.knobs };
    const prior = new PersonaPosterior(pop);
    const w = prior.weights();
    const poolKeys = [...new Set(opts.train.flatMap((p) => p.pool.map((i) => i.key)))].filter((k) =>
      pop.has(k),
    );
    const byTransfer = poolKeys
      .map((key) => ({ key, t: prior.eig(key, refKeys, w) }))
      .sort((a, b) => b.t - a.t || a.key.localeCompare(b.key))
      .slice(0, own.liftShortlist)
      .map((x) => x.key);
    const inPool = new Set(poolKeys);
    const candidates = [
      ...new Set([...byTransfer, ...TWIN_ANCHORS.filter((k) => inPool.has(k)), ...(opts.opening ?? [])]),
    ].filter((k) => inPool.has(k));
    const jev = new JevOracle(predictorFor(deps.gateway, candidate, 'eval.curves.lift'), deps.meter);
    const usd0 = deps.meter.usd;
    lift = await jevLift({
      train: opts.train,
      candidates,
      jev,
      people: own.liftPeople,
      seed: opts.seed,
      tSel: own.tSel,
      concurrency: opts.concurrency,
    });
    liftUsd = deps.meter.usd - usd0;
    if (jev.predictions && jev.failed / jev.predictions > (opts.maxFailureRate ?? 0.02))
      throw new Error(
        `jev-lift: ${jev.failed} of ${jev.predictions} predictions failed while measuring lift; an outage, not a result`,
      );
    console.log(
      `jev-lift: ${candidates.length} candidates on ${Math.min(own.liftPeople, opts.train.length)} train people, $${liftUsd.toFixed(4)}`,
    );
  }
  const policies = buildPolicies(opts.policies, opts.knobs, opts.seed, staticSeq, {
    classesOf,
    ...(opts.opening ? { custom: opts.opening } : {}),
    ...(lift ? { liftSeq: lift.map((r) => r.key) } : {}),
  });
  const vectors = specs.some(needsEmbeddings)
    ? await embedTexts(
        deps.gateway,
        opts.people.flatMap((p) => [...p.pool, ...p.reference].map(textOf)),
        { dir: opts.embedDir ?? 'data/curves-cache/emb', meter: deps.meter },
      )
    : undefined;
  const steps = Math.max(...opts.checkpoints);
  const records: CurveRecord[] = [];
  const reader: CurveRecord[] = [];
  const trajectories = new Map<string, Map<string, TwinItem[]>>(policies.map((p) => [p.name, new Map()]));
  const scores = new Map<string, Map<string, Array<number | null>>>(policies.map((p) => [p.name, new Map()]));
  const costs: RunResult['costs'] = Object.fromEntries(
    policies.map((p) => [p.name, { selection: 0, scoring: 0, requests: 0 }]),
  );
  let stopReason: string | null = null;
  let costliest = 0;

  for (let start = 0; start < opts.people.length; start += opts.chunkPeople) {
    const chunk = opts.people.slice(start, start + opts.chunkPeople);
    if (deps.meter.usd + 1.2 * costliest > deps.meter.maxUsd) {
      stopReason = `the next chunk would pass the $${deps.meter.maxUsd} cap ($${deps.meter.usd.toFixed(4)} spent); ${opts.people.length - start} of ${opts.people.length} people not run`;
      break;
    }
    const before = deps.meter.usd;
    const chunkRecords: CurveRecord[] = [];
    const chunkReader: CurveRecord[] = [];
    const chunkTraj: Array<{ policy: string; pid: string; asked: TwinItem[]; scores: Array<number | null> }> =
      [];
    const chunkCosts = new Map<string, { selection: number; scoring: number; requests: number }>();
    let asked = 0;
    let failed = 0;
    try {
      for (const policy of policies) {
        const jev = new JevOracle(predictorFor(deps.gateway, candidate, 'eval.curves.select'), deps.meter);
        const usd0 = deps.meter.usd;
        const walks = await mapLimit(chunk, opts.concurrency, async (person) => {
          const scores: Array<number | null> = [];
          const asked = await walk(person, policy, steps, {
            jev,
            pop,
            seed: opts.seed,
            scores,
            ...(vectors ? { vectors } : {}),
          });
          return { person, asked, scores };
        });
        const usd1 = deps.meter.usd;
        asked += jev.predictions;
        failed += jev.failed;
        const instances = opts.noJev
          ? []
          : walks.flatMap(({ person, asked }) =>
              opts.checkpoints.flatMap((k) => targetInstances(person, asked, k)),
            );
        const recs = opts.noJev
          ? []
          : await evaluateCandidate(candidate, instances, {
              gateway: deps.gateway,
              meter: deps.meter,
              concurrency: opts.concurrency * 2,
              purpose: 'eval.curves.score',
              maxQuestionsPerRequest: 20,
            });
        asked += recs.length;
        failed += recs.filter((r) => !r.ok).length;
        const blockOf = new Map(walks.flatMap(({ person }) => person.targets.map((t) => [t.key, t.block])));
        recs.forEach((rec, i) => {
          const inst = instances[i]!;
          chunkRecords.push({
            policy: policy.name,
            k: inst.k!,
            block: blockOf.get(inst.question.itemKey!) ?? '',
            rec,
          });
        });
        for (const w of walks)
          chunkTraj.push({ policy: policy.name, pid: w.person.pid, asked: w.asked, scores: w.scores });
        if (pop)
          for (const w of walks) {
            const read = populationReader(
              pop,
              w.person,
              w.asked,
              opts.checkpoints,
              policy.name,
              opts.knobs.beta,
            );
            // Without Jev, the reader is the scorer.
            (opts.noJev ? chunkRecords : chunkReader).push(...read);
          }
        chunkCosts.set(policy.name, {
          selection: usd1 - usd0,
          scoring: deps.meter.usd - usd1,
          requests: jev.requests,
        });
      }
    } catch (e) {
      if (!(e instanceof BudgetStop)) throw e;
      stopReason = `${e.message}; the chunk of ${chunk.length} people starting at ${start} was dropped for every policy`;
      break;
    }
    const maxFail = opts.maxFailureRate ?? 0.02;
    if (asked && failed / asked > maxFail) {
      stopReason = `outage: ${failed} of ${asked} predictions failed in the chunk of ${chunk.length} people starting at ${start} (above ${maxFail * 100}%); it was dropped for every policy and the run stopped`;
      break;
    }
    records.push(...chunkRecords);
    reader.push(...chunkReader);
    for (const t of chunkTraj) {
      trajectories.get(t.policy)!.set(t.pid, t.asked);
      scores.get(t.policy)!.set(t.pid, t.scores);
    }
    for (const [p, c] of chunkCosts) {
      const cur = costs[p]!;
      cur.selection += c.selection;
      cur.scoring += c.scoring;
      cur.requests += c.requests;
    }
    costliest = Math.max(costliest, deps.meter.usd - before);
    console.log(
      `people ${start + 1}–${start + chunk.length} of ${opts.people.length}: $${deps.meter.usd.toFixed(4)} so far`,
    );
  }
  if (liftSpec) {
    const c = costs[liftSpec.spec];
    if (c) c.selection += liftUsd;
  }
  return { records, reader, trajectories, scores, costs, stopReason, staticSequence: staticSeq, lift };
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Policy specs, split at commas outside brackets (`jev-eig[ref=pool,tsel=1],random`). */
export function splitSpecs(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function curvesCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      role: { type: 'string', default: 'dev' },
      people: { type: 'string', default: '150' },
      policies: { type: 'string', default: DEFAULT_POLICIES.join(',') },
      checkpoints: { type: 'string', default: DEFAULT_CHECKPOINTS.join(',') },
      seed: { type: 'string', default: 'e9' },
      'max-usd': { type: 'string', default: '60' },
      concurrency: { type: 'string', default: '6' },
      'in-flight': { type: 'string', default: '16' },
      'chunk-people': { type: 'string', default: '10' },
      cache: { type: 'string', default: 'data/curves-cache' },
      'entropy-shortlist': { type: 'string', default: String(POLICY_DEFAULTS.entropyShortlist) },
      shortlist: { type: 'string', default: String(POLICY_DEFAULTS.lookaheadShortlist) },
      'ref-size': { type: 'string', default: String(POLICY_DEFAULTS.referenceSize) },
      't-sel': { type: 'string', default: String(POLICY_DEFAULTS.tSel) },
      'answer-floor': { type: 'string', default: String(POLICY_DEFAULTS.answerFloor) },
      'static-probes': { type: 'string', default: String(POLICY_DEFAULTS.staticProbes) },
      beta: { type: 'string', default: String(POLICY_DEFAULTS.beta) },
      mmr: { type: 'string', default: String(POLICY_DEFAULTS.mmr) },
      reference: { type: 'string', default: POLICY_DEFAULTS.reference },
      given: { type: 'string' },
      offset: { type: 'string', default: '0' },
      versus: { type: 'string' },
      opening: { type: 'string' },
      classes: { type: 'string', default: String(POLICY_DEFAULTS.classes) },
      'lift-shortlist': { type: 'string', default: String(POLICY_DEFAULTS.liftShortlist) },
      'lift-people': { type: 'string', default: String(POLICY_DEFAULTS.liftPeople) },
      drop: { type: 'string' },
      'train-people': { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      summary: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'no-jev': { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required (the Twin-2K-500 wave_split JSON Lines)');
  const role = values.role as Role;
  if (role !== 'dev' && role !== 'test') throw new Error('--role must be dev or test');
  const policies = splitSpecs(values.policies);
  const specs = policies.map(parsePolicySpec);
  if (values['no-jev'] && specs.some(needsJev))
    throw new Error(
      `--no-jev can't run ${specs
        .filter(needsJev)
        .map((x) => x.spec)
        .join(', ')}: they select with Jev`,
    );
  const checkpoints = [...new Set(list(values.checkpoints).map(Number))].sort((a, b) => a - b);
  if (checkpoints.some((k) => !Number.isInteger(k) || k < 0))
    throw new Error('--checkpoints are whole numbers');
  const knobs: PolicyKnobs = {
    entropyShortlist: positive('entropy-shortlist', values['entropy-shortlist']),
    lookaheadShortlist: positive('shortlist', values.shortlist),
    referenceSize: positive('ref-size', values['ref-size']),
    tSel: positive('t-sel', values['t-sel'], false),
    answerFloor: Number(values['answer-floor']),
    staticProbes: positive('static-probes', values['static-probes']),
    beta: positive('beta', values.beta, false),
    mmr: Number(values.mmr),
    reference: values.reference === 'pool' ? 'pool' : values.reference === 'id' ? 'id' : 'R',
    classes: Number(values.classes),
    liftShortlist: positive('lift-shortlist', values['lift-shortlist']),
    liftPeople: positive('lift-people', values['lift-people']),
  };
  if (!Number.isInteger(knobs.classes) || knobs.classes < 0) throw new Error('--classes is a whole number');
  if (!Number.isInteger(Number(values.offset)) || Number(values.offset) < 0)
    throw new Error('--offset is a whole number of people to skip');
  if (values.reference !== 'R' && values.reference !== 'pool' && values.reference !== 'id')
    throw new Error('--reference is R, pool or id');
  const nPeople = positive('people', values.people);
  const loaded = await loadPeople(values.data, {
    roles: ['train', role],
    offsetPerRole: { [role]: Number(values.offset) },
    limitPerRole: {
      [role]: nPeople,
      ...(values['train-people'] ? { train: positive('train-people', values['train-people']) } : {}),
    },
    seed: values.seed,
  });
  // Given answers move out of everyone's pool, train people's too, so pop-static never plans to ask one.
  const kept = values.drop ? withoutItems(loaded.people, values.drop) : loaded.people;
  const all = values.given ? withGiven(kept, values.given) : kept;
  const people = all.filter((p) => p.role === role);
  const train = all.filter((p) => p.role === 'train');
  if (values.given && !people.some((p) => p.given.length))
    throw new Error(
      `--given ${values.given} names no pool item (blocks: ${[...new Set(people.flatMap((p) => p.pool.map((i) => i.block)))].join(', ')})`,
    );
  console.log(
    `E9: ${policies.join(', ')} on ${people.length} ${role} people (${train.length} train people for population statistics); checkpoints ${checkpoints.join(', ')}`,
  );
  if (!people.length) throw new Error(`no ${role} people in ${values.data}`);
  if (values.opening) {
    const inPools = new Set(people.flatMap((p) => p.pool.map((i) => i.key)));
    const missing = openingKeys(values.opening).filter((k) => !inPools.has(k));
    if (missing.length)
      throw new Error(
        `--opening names items no pool holds (given, dropped or unknown): ${missing.join(', ')}`,
      );
  }

  const runDir = resolve(values.out ?? `data/curves/${ulid()}`);
  mkdirSync(runDir, { recursive: true });
  const engine = await openLocalEngine({
    db: join(runDir, 'calls.sqlite'),
    blobsDir: join(runDir, 'traces'),
    providers: values.offline ? 'offline' : 'live',
    decisionTimeoutMs: DECISION_TIMEOUT_MS,
    spend: {},
  });
  // Offline fakes never share a cache with live answers.
  const cacheDir = resolve(values.offline ? join(runDir, 'cache') : values.cache);
  const gateway = new CachingGateway(engine.deps.gateway.deps, {
    dir: cacheDir,
    maxInFlight: positive('in-flight', values['in-flight']),
  });
  const meter = new Meter(positive('max-usd', values['max-usd'], false));
  const result = await runCurves(
    { gateway, meter },
    {
      people,
      train,
      policies,
      checkpoints,
      knobs,
      seed: values.seed,
      concurrency: positive('concurrency', values.concurrency),
      chunkPeople: positive('chunk-people', values['chunk-people']),
      noJev: values['no-jev'],
      embedDir: join(cacheDir, 'emb'),
      ...(values.opening ? { opening: openingKeys(values.opening) } : {}),
    },
  );
  const consistency = new Map<string, number>();
  for (const p of people) {
    const xs = p.targets.map((t) => p.retest.get(t.key)).filter((x): x is number => x !== undefined);
    if (xs.length) consistency.set(mimicIdOf(p.pid), xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  const trajectories = new Map(
    [...result.trajectories].map(([policy, m]) => [
      policy,
      new Map(
        [...m].map(([pid, asked]) => [
          pid,
          asked.map((i) => ({ key: i.key, block: i.block, prompt: i.prompt })),
        ]),
      ),
    ]),
  );
  const report = analyzeCurves({
    role,
    records: result.records,
    reader: result.reader,
    policies,
    checkpoints,
    consistency,
    costs: result.costs,
    trajectories,
    scores: new Map(
      [...result.scores].map(([policy, m]) => [
        policy,
        new Map([...m].map(([pid, xs]) => [mimicIdOf(pid), xs])),
      ]),
    ),
    audit: {
      ...(loaded.audit as unknown as Record<string, unknown>),
      staticSequence: result.staticSequence?.slice(0, 10) ?? null,
      ...(result.lift
        ? {
            liftTop: result.lift.slice(0, 15).map((r) => `${r.key} ${r.lift.toFixed(4)}±${r.se.toFixed(4)}`),
            liftAnchors: result.lift
              .filter((r) => (TWIN_ANCHORS as readonly string[]).includes(r.key))
              .map((r) => `${r.key} ${r.lift.toFixed(4)}±${r.se.toFixed(4)}`),
          }
        : {}),
      given: values.given ?? null,
      opening: values.opening ?? null,
      drop: values.drop ?? null,
      meanGiven: people.reduce((a, p) => a + p.given.length, 0) / people.length,
    },
    costUsd: meter.usd,
    cache: gateway.stats,
    stopReason: result.stopReason,
    knobs: { ...knobs, population: POPULATION_DEFAULTS },
    offline: values.offline,
    scorer: values['no-jev'] ? 'population' : 'jev',
    seed: values.seed,
    ...(values.versus ? { versus: splitSpecs(values.versus) } : {}),
  });
  const st = statSync(values.data);
  const run: EvalRunRecord = {
    id: ulid(),
    name: values.name ?? `E9: learning curves of selection policies (${role})`,
    spec: {
      kind: 'curves',
      role,
      people: people.length,
      policies,
      checkpoints,
      knobs,
      seed: values.seed,
      maxUsd: meter.maxUsd,
      data: basename(values.data),
      ...(values.given ? { given: values.given } : {}),
      ...(values.opening ? { opening: values.opening } : {}),
      ...(Number(values.offset) ? { offset: Number(values.offset) } : {}),
      ...(values.drop ? { drop: values.drop } : {}),
      stopReason: result.stopReason,
    },
    datasetHash: sha256Hex(`${basename(values.data)}:${st.size}:${people.map((p) => p.pid).join(',')}`),
    status: 'done',
    metrics: { report, modelSnapshots: [...new Set(result.records.map((r) => r.rec.modelSnapshot))].sort() },
    r2ReportKey: null,
    createdAt: Date.now(),
  };
  try {
    await engine.deps.store.putEvalRun(run);
  } finally {
    engine.close();
  }
  const files = writeReport(run);
  if (values.summary) appendFileSync(values.summary, `${renderReport(run)}\n\n`);
  console.log(renderReport(run));
  console.log(`\nrun ${run.id} → ${files.md}; calls and traces in ${runDir}; request cache in ${cacheDir}`);
}

export type { EvalRecord, LoadAudit };
