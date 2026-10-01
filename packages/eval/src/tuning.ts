import {
  P_FLOOR,
  type PredictComponents,
  type PredictHarness,
  type StateView,
  temperatureScale,
} from '@mimic/core';
import { type EvalRecord, rescaled, TEMPERATURE_GRID } from './optimize/evaluate';

/**
 * E8b (docs/MODELS.md §9, ADR-0069): each decision model at its best. None of the Decisions APIs takes a sampling
 * parameter, so the settings worth tuning are on Mimic's side: what the model reads, how a question is written, and
 * the temperature applied to its answer. The grid is fixed before any run; a person is scored at the setting and
 * temperatures chosen on everyone else, so the tuned score carries no selection optimism.
 */

/** How the request is written: one candidate (and one prompt hash) per model and variant. */
export interface RequestVariant {
  harness: Partial<PredictHarness>;
  components: Partial<PredictComponents>;
}

/** Short labels in place of Jev's templates, as the vendors' own examples write them. */
export const PLAIN_COMPONENTS: Partial<PredictComponents> = {
  'jev.instructions': 'How would this person answer "{prompt}"?',
  'jev.choice': '{label}',
  'jev.noul.true': 'Yes',
  'jev.noul.false': 'No',
};

export const REQUEST_VARIANTS = {
  /** Jev's templates, the state as JSON, scales as `score`: E8 as run. */
  incumbent: { harness: {}, components: {} },
  /** Scales asked as unordered choices (ADR-0066). */
  choice: { harness: { scoreAs: 'choice' }, components: {} },
  /** The state as the text the LLMs see. */
  text: { harness: { jevState: 'text' }, components: {} },
  plain: { harness: {}, components: PLAIN_COMPONENTS },
} as const satisfies Record<string, RequestVariant>;
export type RequestKey = keyof typeof REQUEST_VARIANTS;

/** A view of the sealed state, asked with one request variant. */
export interface Setting {
  key: string;
  view: StateView;
  request: RequestKey;
}

/** E8 as pre-registered: the state as served, and the context alone. */
export const E8_SETTINGS: Setting[] = [
  { key: 'full', view: 'full', request: 'incumbent' },
  { key: 'context', view: 'context', request: 'incumbent' },
];

/**
 * E8b's grid, in tie-break order: an exact tie goes to the earlier setting, so the incumbent wins one, and on Twin
 * (no traits or insights) `answers` never displaces the identical `full`, nor `derived` the identical `context`.
 */
export const TUNE_SETTINGS: Setting[] = [
  ...E8_SETTINGS,
  { key: 'answers', view: 'answers', request: 'incumbent' },
  { key: 'derived', view: 'derived', request: 'incumbent' },
  { key: 'full+choice', view: 'full', request: 'choice' },
  { key: 'context+choice', view: 'context', request: 'choice' },
  { key: 'answers+choice', view: 'answers', request: 'choice' },
  { key: 'derived+choice', view: 'derived', request: 'choice' },
  { key: 'full+text', view: 'full', request: 'text' },
  { key: 'full+plain', view: 'full', request: 'plain' },
];

/** One temperature per model, or one per question type (yes/no, choice, scale). */
export type Calibration = 'one' | 'type';
export const CALIBRATIONS: Calibration[] = ['one', 'type'];

export interface TuneConfig {
  setting: string;
  calibration: Calibration;
}

export const configLabel = (c: TuneConfig) =>
  c.calibration === 'one' ? c.setting : `${c.setting}, T by type`;

export interface TuneResult {
  /** Each person's records at the configuration and temperatures chosen on everyone else. */
  records: EvalRecord[];
  /** The configuration chosen on everyone: the one to deploy. */
  chosen: TuneConfig;
  /** People whose own fold chose `chosen`, of `people`. */
  agree: number;
  people: number;
  /** Every configuration's mean log loss at leave-one-person-out temperatures (E8's score), in grid order. */
  scores: Array<{ config: TuneConfig; logLoss: number }>;
}

/** Summed log loss per temperature over a group of one person's answered predictions. */
interface Sums {
  n: number;
  ll: Float64Array;
}

interface PersonStats {
  /** Every prediction, failed ones included. */
  n: number;
  /** Failed predictions score as uniform at any temperature. */
  failed: number;
  /** `*` is every answered prediction; the rest are per question type. */
  groups: Map<string, Sums>;
}

/**
 * Picks each model's configuration by nested leave-one-person-out cross-validation. For person p, every
 * configuration is scored on everyone else, each of them at temperatures fitted without p or themselves; p is then
 * scored at the winner, with temperatures fitted without p. `bySetting` holds one arm's records per setting, all on
 * the same instances; `order` is the tie-break order.
 */
export function tune(
  bySetting: Map<string, EvalRecord[]>,
  order: string[],
  grid: readonly number[] = TEMPERATURE_GRID,
): TuneResult {
  const settings = order.filter((s) => bySetting.has(s));
  if (!settings.length) throw new Error('tune needs at least one setting');
  const ids = (s: string) => new Set(bySetting.get(s)!.map((r) => r.instanceId));
  const base = ids(settings[0]!);
  for (const s of settings.slice(1)) {
    const x = ids(s);
    if (x.size !== base.size || [...x].some((id) => !base.has(id)))
      throw new Error(`setting ${s} scored other instances than ${settings[0]}`);
  }

  const temps = [1, ...grid.filter((t) => t !== 1)];
  const lossAt = (r: EvalRecord, t: number) =>
    t === 1 ? r.logLoss : -Math.log(Math.max(temperatureScale(r.dist, t)[r.answer] ?? 0, P_FLOOR));
  const add = (m: Map<string, Sums>, g: string, ll: number[]) => {
    const s = m.get(g) ?? { n: 0, ll: new Float64Array(temps.length) };
    s.n++;
    ll.forEach((x, i) => {
      s.ll[i]! += x;
    });
    m.set(g, s);
  };

  const people = [...new Set(bySetting.get(settings[0]!)!.map((r) => r.mimicId))];
  const stats = new Map<string, Map<string, PersonStats>>();
  const totals = new Map<string, Map<string, Sums>>();
  for (const s of settings) {
    const byPerson = new Map<string, PersonStats>();
    const total = new Map<string, Sums>();
    for (const r of bySetting.get(s)!) {
      const p = byPerson.get(r.mimicId) ?? { n: 0, failed: 0, groups: new Map() };
      p.n++;
      if (!r.ok) p.failed += r.logLoss;
      else {
        const ll = temps.map((t) => lossAt(r, t));
        for (const g of ['*', r.type]) {
          add(p.groups, g, ll);
          add(total, g, ll);
        }
      }
      byPerson.set(r.mimicId, p);
    }
    stats.set(s, byPerson);
    totals.set(s, total);
  }

  /** The temperature index fitted on everyone but `out` (1 when nobody is left). */
  const tempAt = (s: string, g: string, out: string[]): number => {
    const t = totals.get(s)!.get(g);
    if (!t) return 0;
    const ex = out.map((p) => stats.get(s)!.get(p)?.groups.get(g)).filter((x): x is Sums => !!x);
    if (t.n - ex.reduce((a, x) => a + x.n, 0) <= 0) return 0;
    let at = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < temps.length; i++) {
      let ll = t.ll[i]!;
      for (const x of ex) ll -= x.ll[i]!;
      if (ll < best - 1e-9) {
        best = ll;
        at = i;
      }
    }
    return at;
  };
  const groupsOf = (s: string, q: string, c: Calibration) =>
    c === 'one' ? ['*'] : [...(stats.get(s)!.get(q)?.groups.keys() ?? [])].filter((g) => g !== '*');
  /** Person q's summed log loss at configuration c, temperatures fitted without `out`. */
  const lossOf = (c: TuneConfig, q: string, out: string[]): number => {
    const st = stats.get(c.setting)!.get(q);
    if (!st) return 0;
    let ll = st.failed;
    for (const g of groupsOf(c.setting, q, c.calibration))
      ll += st.groups.get(g)!.ll[tempAt(c.setting, g, out)]!;
    return ll;
  };
  const nOf = (q: string) => stats.get(settings[0]!)!.get(q)?.n ?? 0;

  const configs = settings.flatMap((setting) =>
    CALIBRATIONS.map((calibration) => ({ setting, calibration })),
  );
  const pick = (score: (c: TuneConfig) => number): TuneConfig => {
    let at = configs[0]!;
    let best = Number.POSITIVE_INFINITY;
    for (const c of configs) {
      const x = score(c);
      if (x < best - 1e-12) {
        best = x;
        at = c;
      }
    }
    return at;
  };

  const n = people.reduce((a, q) => a + nOf(q), 0);
  const scores = configs.map((config) => ({
    config,
    logLoss: n ? people.reduce((a, q) => a + lossOf(config, q, [q]), 0) / n : 0,
  }));
  const chosen = pick((c) => scores.find((x) => x.config === c)!.logLoss);

  const records: EvalRecord[] = [];
  let agree = 0;
  for (const p of people) {
    const rest = people.filter((q) => q !== p);
    const restN = rest.reduce((a, q) => a + nOf(q), 0);
    // Alone, a person has no one to choose for them: the first setting, one temperature of 1.
    const mine = restN
      ? pick((c) => rest.reduce((a, q) => a + lossOf(c, q, [p, q]), 0) / restN)
      : configs[0]!;
    if (mine.setting === chosen.setting && mine.calibration === chosen.calibration) agree++;
    for (const r of bySetting.get(mine.setting)!) {
      if (r.mimicId !== p) continue;
      const g = mine.calibration === 'one' ? '*' : r.type;
      records.push(rescaled(r, temps[tempAt(mine.setting, g, [p])]!));
    }
  }
  return { records, chosen, agree, people: people.length, scores };
}
