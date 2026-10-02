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
} from '../optimize/evaluate';
import type { EvalInstance } from '../optimize/instances';
import { renderReport, writeReport } from '../report';
import { analyzeCurves, type CurveRecord, type CurvesReport, renderCurves } from './analyze';
import {
  type LoadAudit,
  loadPeople,
  mimicIdOf,
  questionOf,
  type Role,
  stateAfter,
  type TwinItem,
  type TwinPerson,
} from './data';
import {
  hybridPolicy,
  JevOracle,
  jevEigPolicy,
  jevEntropyPolicy,
  orderPolicy,
  POLICY_DEFAULTS,
  POLICY_NAMES,
  type Policy,
  type PolicyKnobs,
  type PolicyName,
  popEigPolicy,
  popStaticPolicy,
  randomPolicy,
  stratifiedPolicy,
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
  ctx: { jev: JevOracle; pop: Population | null; seed: string },
): Promise<TwinItem[]> {
  const rng = seededRng(`${ctx.seed}:${policy.name}:${person.pid}`);
  const asked: TwinItem[] = [];
  let remaining = [...person.pool];
  const posterior = policy.usesPopulation && ctx.pop ? new PersonaPosterior(ctx.pop) : null;
  for (let t = 0; t < Math.min(steps, person.pool.length); t++) {
    const item = await policy.next({
      person,
      asked,
      remaining,
      state: stateAfter(person.pid, asked),
      rng,
      jev: ctx.jev,
      pop: ctx.pop,
      posterior,
    });
    if (!remaining.includes(item)) throw new Error(`${policy.name} picked ${item.key}, not in the pool`);
    asked.push(item);
    remaining = remaining.filter((i) => i !== item);
    if (posterior && ctx.pop) posterior.observe(item.key, ctx.pop.indexOf(item));
  }
  return asked;
}

/** The scored instances for one person after the first k asked: every target T from the sealed state. */
export function targetInstances(person: TwinPerson, asked: readonly TwinItem[], k: number): EvalInstance[] {
  const mimicId = mimicIdOf(person.pid);
  const state = stateAfter(person.pid, asked.slice(0, k));
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

export function buildPolicies(
  names: readonly string[],
  knobs: PolicyKnobs,
  seed: string,
  staticSeq: readonly string[] | null,
): Policy[] {
  return names.map((n) => {
    switch (n) {
      case 'order':
        return orderPolicy;
      case 'random':
        return randomPolicy;
      case 'stratified':
        return stratifiedPolicy;
      case 'jev-entropy':
        return jevEntropyPolicy(knobs);
      case 'pop-eig':
        return popEigPolicy;
      case 'pop-static':
        if (!staticSeq) throw new Error('pop-static needs a static sequence');
        return popStaticPolicy(staticSeq);
      case 'jev-eig':
        return jevEigPolicy(knobs, seed);
      case 'hybrid':
        return hybridPolicy(knobs, seed);
      default:
        throw new Error(`unknown policy ${n} (known: ${POLICY_NAMES.join(', ')})`);
    }
  });
}

export interface RunOptions {
  people: TwinPerson[];
  train: TwinPerson[];
  policies: string[];
  checkpoints: number[];
  knobs: PolicyKnobs;
  seed: string;
  /** People run at once. */
  concurrency: number;
  /** People per chunk: a budget stop drops the chunk for every policy, so the arms stay paired. */
  chunkPeople: number;
}

export interface RunResult {
  records: CurveRecord[];
  trajectories: Map<string, Map<string, TwinItem[]>>;
  costs: Record<string, { selection: number; scoring: number; requests: number }>;
  stopReason: string | null;
  staticSequence: string[] | null;
}

/** Runs every policy on every person, chunk by chunk, then scores the targets at each checkpoint. */
export async function runCurves(deps: CurvesDeps, opts: RunOptions): Promise<RunResult> {
  const needsPop = opts.policies.some((p) => p === 'pop-eig' || p === 'hybrid' || p === 'pop-static');
  const pop = needsPop ? new Population(opts.train, POPULATION_DEFAULTS) : null;
  const refKeys = [...new Set(opts.train.flatMap((p) => p.reference.map((r) => r.key)))];
  const staticSeq =
    pop && opts.policies.includes('pop-static')
      ? staticSequence(pop, opts.train, refKeys, {
          steps: Math.max(...opts.checkpoints),
          probes: opts.knobs.staticProbes,
          seed: opts.seed,
        })
      : null;
  const policies = buildPolicies(opts.policies, opts.knobs, opts.seed, staticSeq);
  const candidate = resolveCandidate({ predictor: JEV_PREDICTOR });
  const steps = Math.max(...opts.checkpoints);
  const records: CurveRecord[] = [];
  const trajectories = new Map<string, Map<string, TwinItem[]>>(policies.map((p) => [p.name, new Map()]));
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
    const chunkTraj: Array<{ policy: string; pid: string; asked: TwinItem[] }> = [];
    const chunkCosts = new Map<string, { selection: number; scoring: number; requests: number }>();
    try {
      for (const policy of policies) {
        const jev = new JevOracle(predictorFor(deps.gateway, candidate, 'eval.curves.select'), deps.meter);
        const usd0 = deps.meter.usd;
        const walks = await mapLimit(chunk, opts.concurrency, async (person) => ({
          person,
          asked: await walk(person, policy, steps, { jev, pop, seed: opts.seed }),
        }));
        const usd1 = deps.meter.usd;
        const instances = walks.flatMap(({ person, asked }) =>
          opts.checkpoints.flatMap((k) => targetInstances(person, asked, k)),
        );
        const recs = await evaluateCandidate(candidate, instances, {
          gateway: deps.gateway,
          meter: deps.meter,
          concurrency: opts.concurrency * 2,
          purpose: 'eval.curves.score',
          maxQuestionsPerRequest: 20,
        });
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
        for (const w of walks) chunkTraj.push({ policy: policy.name, pid: w.person.pid, asked: w.asked });
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
    records.push(...chunkRecords);
    for (const t of chunkTraj) trajectories.get(t.policy)!.set(t.pid, t.asked);
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
  return { records, trajectories, costs, stopReason, staticSequence: staticSeq };
}

const list = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

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
      'train-people': { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      summary: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (!values.data) throw new Error('--data is required (the Twin-2K-500 wave_split JSON Lines)');
  const role = values.role as Role;
  if (role !== 'dev' && role !== 'test') throw new Error('--role must be dev or test');
  const policies = list(values.policies);
  for (const p of policies)
    if (!(POLICY_NAMES as readonly string[]).includes(p)) throw new Error(`unknown policy ${p}`);
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
  };
  const nPeople = positive('people', values.people);
  const needsTrain = policies.some((p) => p.startsWith('pop-') || p === 'hybrid');
  const loaded = await loadPeople(values.data, {
    roles: needsTrain ? ['train', role] : [role],
    limitPerRole: {
      [role]: nPeople,
      ...(values['train-people'] ? { train: positive('train-people', values['train-people']) } : {}),
    },
    seed: values.seed,
  });
  const people = loaded.people.filter((p) => p.role === role);
  const train = loaded.people.filter((p) => p.role === 'train');
  console.log(
    `E9: ${policies.join(', ')} on ${people.length} ${role} people (${train.length} train people for population statistics); checkpoints ${checkpoints.join(', ')}`,
  );
  if (!people.length) throw new Error(`no ${role} people in ${values.data}`);

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
    policies,
    checkpoints,
    consistency,
    costs: result.costs,
    trajectories,
    audit: {
      ...(loaded.audit as unknown as Record<string, unknown>),
      staticSequence: result.staticSequence?.slice(0, 10) ?? null,
    },
    costUsd: meter.usd,
    cache: gateway.stats,
    stopReason: result.stopReason,
    knobs: { ...knobs, population: POPULATION_DEFAULTS },
    offline: values.offline,
    seed: values.seed,
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
