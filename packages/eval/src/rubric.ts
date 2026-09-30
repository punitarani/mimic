import {
  CATEGORIES,
  type Category,
  categoryShares,
  type EngineDeps,
  type EvalRunRecord,
  facetsFor,
  isScoredKind,
  loadConfig,
  type MimicRecord,
  type QuestionRecord,
  ulid,
} from '@mimic/core';

/**
 * `mimic-eval rubric` (ADR-0044): what the question loop served, person by person, against the M9–M13 rubric rows a
 * session's structure can show (PLAN §14). Nothing here is prediction accuracy; R6 is measured by `select --series`
 * and the lab. Every person is labelled by population (real, scripted, twin2k), so scripted runs are never read as
 * results about people.
 *
 * - R1 concreteness: generated questions served, and how many passed the `concrete` gate (gates.v3, p ≥ 0.4).
 * - R2 breadth: each category's share of the anchor and adaptive questions up to question 30 (a question touching two
 *   categories counts half to each), and the facet groups in scope touched by question 20.
 * - R4 sensitive coverage: the consented sensitive facets touched by question 30.
 * - R7 ordering: questions touching a sensitive facet among the first five, and the first such seq.
 */

export const CONCRETE_MIN = 0.4;
export const SHARE_BOUNDS = { min: 0.15, max: 0.4 } as const;
export const BY = { shares: 30, groups: 20, sensitive: 30, early: 5 } as const;

export const POPULATIONS = ['real', 'scripted', 'twin2k'] as const;
export type Population = (typeof POPULATIONS)[number];

export function populationOf(participantId: string): Population {
  if (participantId.startsWith('script:')) return 'scripted';
  if (participantId.startsWith('twin2k:')) return 'twin2k';
  return 'real';
}

export interface RubricPerson {
  mimicId: string;
  population: Population;
  config: string;
  arm: string | null;
  categories: Category[];
  consents: string[];
  answered: number;
  generatedServed: number;
  concreteKnown: number;
  concretePassed: number;
  reserveServed: number;
  shares: Partial<Record<Category, number>>;
  /** All four categories selected and every share within SHARE_BOUNDS by question 30 (null with fewer selected). */
  sharesInBounds: boolean | null;
  groupsInScope: number;
  groupsTouched: number;
  groupsMissing: string[];
  sensitiveInScope: number;
  sensitiveReached: number;
  sensitiveMissing: string[];
  sensitiveEarly: number;
  firstSensitiveSeq: number | null;
}

export async function rubricPerson(deps: EngineDeps, m: MimicRecord): Promise<RubricPerson> {
  const cfg = await loadConfig(deps, m.configHash);
  const label = (await deps.store.getConfig(m.configHash))?.label ?? m.configHash.slice(0, 12);
  const facets = await facetsFor(deps, m, cfg);
  const byId = new Map(facets.map((f) => [f.id, f]));
  const served = (await deps.store.listQuestions(m.id))
    .filter((q): q is QuestionRecord & { seq: number } => q.seq !== null && q.status !== 'discarded')
    .sort((a, b) => a.seq - b.seq);
  const scored = served.filter((q) => isScoredKind(q.kind));
  const upTo = (n: number) => scored.filter((q) => q.seq <= n);

  const generated = served.filter((q) => q.kind === 'adaptive' && !q.itemKey);
  const concrete = generated
    .map((q) => (q.quality?.gates as Record<string, number> | undefined)?.concrete)
    .filter((p): p is number => typeof p === 'number');

  // The belief state's own shares (ADR-0044), so the rubric reads balance exactly as the selector does.
  const byCategory = categoryShares(
    facets,
    upTo(BY.shares).map((q) => q.facetIds),
  );
  const inScope = CATEGORIES.filter((c) => byCategory[c]);
  const shares = Object.fromEntries(inScope.map((c) => [c, byCategory[c]!.share]));
  const allFour = inScope.length === CATEGORIES.length;

  const groups = [...new Set(facets.map((f) => f.group))];
  const touched = new Set(upTo(BY.groups).flatMap((q) => q.facetIds.map((f) => byId.get(f)?.group)));
  const sensitive = facets.filter((f) => f.sensitive).map((f) => f.id);
  const reached = new Set(upTo(BY.sensitive).flatMap((q) => q.facetIds));
  const touchesSensitive = (q: QuestionRecord) => q.facetIds.some((f) => byId.get(f)?.sensitive);
  const firstSensitive = served.find(touchesSensitive);

  return {
    mimicId: m.id,
    population: populationOf(m.participantId),
    config: label,
    arm: m.arm,
    categories: inScope,
    consents: Object.keys(m.scope.consents).filter(
      (a) => m.scope.consents[a as keyof typeof m.scope.consents],
    ),
    answered: served.filter((q) => q.status === 'answered').length,
    generatedServed: generated.length,
    concreteKnown: concrete.length,
    concretePassed: concrete.filter((p) => p >= CONCRETE_MIN).length,
    reserveServed: served.filter((q) => q.kind === 'adaptive' && !!q.itemKey).length,
    shares,
    sharesInBounds: allFour
      ? Object.values(shares).every((s) => s >= SHARE_BOUNDS.min && s <= SHARE_BOUNDS.max)
      : null,
    groupsInScope: groups.length,
    groupsTouched: groups.filter((g) => touched.has(g)).length,
    groupsMissing: groups.filter((g) => !touched.has(g)),
    sensitiveInScope: sensitive.length,
    sensitiveReached: sensitive.filter((f) => reached.has(f)).length,
    sensitiveMissing: sensitive.filter((f) => !reached.has(f)),
    sensitiveEarly: served.filter((q) => q.seq <= BY.early && touchesSensitive(q)).length,
    firstSensitiveSeq: firstSensitive?.seq ?? null,
  };
}

export interface RubricGroup {
  population: Population;
  config: string;
  arm: string | null;
  people: number;
  /** People who reached question 30. */
  complete: number;
  concrete: { known: number; passed: number; share: number | null };
  reserveServed: number;
  shares: Partial<Record<Category, { mean: number; min: number; max: number }>>;
  sharesInBounds: { people: number; of: number };
  groups: { touched: number; inScope: number; allTouched: number };
  sensitive: { reached: number; inScope: number; allReached: number; of: number };
  early: { people: number; questions: number };
}

export function summarize(people: RubricPerson[], opts: { byArm?: boolean } = {}): RubricGroup[] {
  const key = (p: RubricPerson) => `${p.population}|${p.config}|${opts.byArm ? (p.arm ?? '') : ''}`;
  const groups = new Map<string, RubricPerson[]>();
  for (const p of people) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return [...groups.values()].map((ps) => {
    const known = sum(ps.map((p) => p.concreteKnown));
    const passed = sum(ps.map((p) => p.concretePassed));
    const shares: RubricGroup['shares'] = {};
    for (const c of CATEGORIES) {
      const xs = ps.map((p) => p.shares[c]).filter((x): x is number => x !== undefined);
      if (xs.length) shares[c] = { mean: sum(xs) / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
    }
    const bounded = ps.filter((p) => p.sharesInBounds !== null);
    const consented = ps.filter((p) => p.sensitiveInScope > 0);
    return {
      population: ps[0]!.population,
      config: ps[0]!.config,
      arm: opts.byArm ? ps[0]!.arm : null,
      people: ps.length,
      complete: ps.filter((p) => p.answered >= BY.sensitive).length,
      concrete: { known, passed, share: known ? passed / known : null },
      reserveServed: sum(ps.map((p) => p.reserveServed)),
      shares,
      sharesInBounds: { people: bounded.filter((p) => p.sharesInBounds).length, of: bounded.length },
      groups: {
        touched: sum(ps.map((p) => p.groupsTouched)),
        inScope: sum(ps.map((p) => p.groupsInScope)),
        allTouched: ps.filter((p) => p.groupsTouched === p.groupsInScope).length,
      },
      sensitive: {
        reached: sum(consented.map((p) => p.sensitiveReached)),
        inScope: sum(consented.map((p) => p.sensitiveInScope)),
        allReached: consented.filter((p) => p.sensitiveReached === p.sensitiveInScope).length,
        of: consented.length,
      },
      early: {
        people: ps.filter((p) => p.sensitiveEarly > 0).length,
        questions: sum(ps.map((p) => p.sensitiveEarly)),
      },
    };
  });
}

export async function rubricRun(
  deps: EngineDeps,
  spec: { name: string; byArm?: boolean; population?: Population[] },
  datasetHash: string,
): Promise<{ run: EvalRunRecord; people: RubricPerson[]; groups: RubricGroup[] }> {
  // Consent gates research use (PLAN §3.8), as in `select`; exports hold only consented people anyway.
  const mimics = await deps.store.listMimics({ consentResearch: true });
  const people: RubricPerson[] = [];
  for (const m of mimics) {
    const p = await rubricPerson(deps, m);
    if (!spec.population || spec.population.includes(p.population)) people.push(p);
  }
  const groups = summarize(people, spec.byArm ? { byArm: true } : {});
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { kind: 'rubric', byArm: !!spec.byArm, population: spec.population ?? 'all' },
    datasetHash,
    status: 'done',
    metrics: { groups, people },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, people, groups };
}

const pct = (x: number | null | undefined) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—');

/** Markdown for a rubric run; scripted and twin2k groups are labelled as such in every table. */
export function renderRubric(groups: RubricGroup[]): string[] {
  const who = (g: RubricGroup) =>
    `${g.population === 'real' ? 'real people' : g.population === 'scripted' ? 'scripted (not a result)' : 'twin2k (imported)'} · ${g.config}${g.arm ? ` · arm ${g.arm}` : ''}`;
  const lines = [
    '## Question loop rubric (ADR-0044)',
    '',
    'Rows by population and config. Scripted sessions test the machinery; only real people are results.',
    '',
    '| Group | People (≥ 30 answers) | R1 concrete (generated) | R2 shares by 30 (mean, min–max) | R2 in 15–40% | R2 groups by 20 | R4 sensitive by 30 | R7 sensitive in first 5 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const g of groups) {
    const shares = CATEGORIES.filter((c) => g.shares[c])
      .map((c) => {
        const s = g.shares[c]!;
        return `${c} ${pct(s.mean)} (${pct(s.min)}–${pct(s.max)})`;
      })
      .join('; ');
    lines.push(
      `| ${who(g)} | ${g.people} (${g.complete}) | ${g.concrete.passed}/${g.concrete.known} (${pct(g.concrete.share)}) | ${shares} | ${g.sharesInBounds.of ? `${g.sharesInBounds.people}/${g.sharesInBounds.of}` : '—'} | ${g.groups.touched}/${g.groups.inScope}; all touched ${g.groups.allTouched}/${g.people} | ${g.sensitive.of ? `${g.sensitive.reached}/${g.sensitive.inScope}; all reached ${g.sensitive.allReached}/${g.sensitive.of}` : '—'} | ${g.early.people} people, ${g.early.questions} questions |`,
    );
  }
  lines.push('');
  return lines;
}
