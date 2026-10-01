import {
  type CopulaFit,
  conditionalAnswer,
  drawKey,
  type EngineDeps,
  type EvalRunRecord,
  type Facet,
  facetAllowed,
  facetReading,
  fitCopula,
  getOntology,
  leakR2,
  loadConfig,
  nearest,
  type Population,
  populationOf,
  type RealismMetrics,
  realism,
  researchAllowed,
  sampleCopula,
  seededRng,
  shuffle,
  ulid,
} from '@mimic/core';

/**
 * `pnpm eval -- population` (ADR-0057): a calibrated population of synthetic agents built from consented real mimics,
 * for simulations. Anchor-and-fill: a Gaussian copula over the cohort's facet means gives new facet vectors with the
 * cohort's marginals and (shrunk) correlation structure; each agent then answers the cohort's stable items by drawing
 * from the answer frequencies of its nearest real exemplars, shrunk toward the population's, so an agent is a
 * mixture of people rather than a copy of one. Realism is measured against the cohort itself: dispersion ratio,
 * caricature, correlation-structure distance, coverage, re-identification, and sensitive-facet leakage. Nothing
 * identifying leaves: no names, facts, free text or reasons, and aggregate frequencies only from groups of
 * `minPeople` or more (PLAN §3.8).
 */

export const POPULATION_SCHEMA = 'mimic-population/1';

export interface PopulationSpec {
  name: string;
  split: 'dev' | 'test' | 'all';
  /** Real people only (the default), or every consented mimic (scripted and imported too: machinery checks). */
  population: 'real' | 'all';
  agents: number;
  /** Nearest real exemplars an agent draws its answers from. */
  k: number;
  /** Prior weight (people) pulling the correlation structure toward independence. */
  kappa: number;
  /** Fewest people a facet or an item needs before it is modelled or exported. */
  minPeople: number;
  seed: string;
}

export interface SyntheticAgent {
  id: string;
  /** Facet id → mean in [0, 1]. */
  facets: Record<string, number>;
  /** Facet id → the reading in words, from the facet's five labels. */
  readings: Record<string, string>;
  answers: Array<{ itemKey: string; prompt: string; options: string[]; answer: string }>;
  /** Concordia `basic__Entity` params plus a memory bank of plain-text rows (ADR-0057). */
  concordia: { prefab: string; params: { name: string; goal: string }; memories: string[] };
  /** Generative-agents style scratch fields. */
  smallville: { innate: string; learned: string; currently: string; lifestyle: string };
}

export interface PopulationDoc {
  schema: typeof POPULATION_SCHEMA;
  createdAt: number;
  seed: string;
  source: { people: number; split: string; population: string; datasetHash: string; minPeople: number };
  dims: string[];
  fit: { weight: number; kappa: number; k: number };
  realism: RealismMetrics;
  /** Cross-validated R² of each sensitive facet from the non-sensitive ones: real cohort vs synthetic population. */
  leak: Array<{ facet: string; real: number | null; synthetic: number | null }>;
  items: Array<{ itemKey: string; people: number }>;
  /** Items with a facet, for an in-simulation questionnaire (Concordia `interviewer__GameMaster`). */
  questionnaire: Array<{
    itemKey: string;
    statement: string;
    choices: string[];
    dimension: string;
    ascending: boolean;
  }>;
  agents: SyntheticAgent[];
}

export interface PopulationResult {
  run: EvalRunRecord;
  doc: PopulationDoc;
}

interface Person {
  id: string;
  vector: number[];
  answers: Map<string, string>;
}

interface Item {
  itemKey: string;
  prompt: string;
  options: Array<{ key: string; label: string }>;
  facetIds: string[];
  type: 'choice' | 'noul' | 'score';
}

const DECISIVE = 0.2;

export async function buildPopulation(
  deps: EngineDeps,
  spec: PopulationSpec,
  datasetHash: string,
): Promise<PopulationResult> {
  const all = await deps.store.listMimics({ consentResearch: true });
  const mimics = all.filter(
    (m) =>
      (spec.split === 'all' || m.split === spec.split) &&
      (spec.population === 'all' || populationOf(m.participantId) === ('real' satisfies Population)),
  );
  // One ontology for the cohort: the default config's, so facet ids line up across people.
  const facets: Facet[] = mimics.length
    ? getOntology((await loadConfig(deps, mimics[0]!.configHash)).ontologyVersion)
    : [];
  const facetById = new Map(facets.map((f) => [f.id, f]));
  const dims = facets.map((f) => f.id);
  const people: Person[] = [];
  const items = new Map<string, Item>();
  for (const m of mimics) {
    const traits = await deps.store.listTraits(m.id);
    const latest = new Map<string, { mean: number; method: string; seqUpTo: number }>();
    for (const t of traits) {
      const cur = latest.get(t.facetId);
      const better =
        !cur ||
        (t.method === 'jev' && cur.method !== 'jev') ||
        (t.method === cur.method && t.seqUpTo > cur.seqUpTo);
      if (better) latest.set(t.facetId, { mean: t.mean, method: t.method, seqUpTo: t.seqUpTo });
    }
    const vector = facets.map((f) => {
      const t = latest.get(f.id);
      // Out of the person's scope, or special-category without research consent: missing, never a value.
      if (!t || !facetAllowed(m.scope, f) || !researchAllowed(m.scope, [f.id], facetById)) return Number.NaN;
      return t.mean;
    });
    const qs = await deps.store.listQuestions(m.id);
    const as = new Map((await deps.store.listAnswers(m.id)).map((a) => [a.questionId, a.value]));
    const answers = new Map<string, string>();
    for (const q of qs) {
      if (!q.itemKey || (q.kind !== 'anchor' && q.kind !== 'adaptive') || q.status !== 'answered') continue;
      if (!researchAllowed(m.scope, q.facetIds, facetById)) continue;
      const v = as.get(q.id);
      if (v === undefined || answers.has(q.itemKey)) continue;
      answers.set(q.itemKey, v);
      if (!items.has(q.itemKey))
        items.set(q.itemKey, {
          itemKey: q.itemKey,
          prompt: q.prompt,
          options: q.options,
          facetIds: q.facetIds,
          type: q.type,
        });
    }
    people.push({ id: m.id, vector, answers });
  }

  // Facets and items below the group minimum are dropped before anything is fitted or exported.
  const keep = dims.map(
    (_, j) => people.filter((p) => Number.isFinite(p.vector[j]!)).length >= spec.minPeople,
  );
  const keptDims = dims.filter((_, j) => keep[j]);
  const real = people.map((p) => p.vector.filter((_, j) => keep[j]));
  const itemPeople = [...items.values()]
    .map((it) => ({ it, n: people.filter((p) => p.answers.has(it.itemKey)).length }))
    .filter(({ n }) => n >= spec.minPeople)
    .sort((a, b) => a.it.itemKey.localeCompare(b.it.itemKey));

  const fit: CopulaFit = fitCopula(keptDims, real, { kappa: spec.kappa });
  const vectors =
    people.length >= spec.minPeople ? sampleCopula(fit, spec.agents, `${spec.seed}:copula`) : [];
  const rng = seededRng(`${spec.seed}:answers`);
  const agents: SyntheticAgent[] = vectors.map((v, i) => {
    const neighbours = nearest(v, real, spec.k).map((idx) => people[idx]!);
    const facetsOut: Record<string, number> = {};
    const readings: Record<string, string> = {};
    keptDims.forEach((id, j) => {
      const mean = Math.min(1, Math.max(0, v[j]!));
      facetsOut[id] = Math.round(mean * 1000) / 1000;
      readings[id] = facetReading(facetById.get(id)!.labels, mean);
    });
    const answers: SyntheticAgent['answers'] = [];
    for (const { it } of itemPeople) {
      const keys = it.options.map((o) => o.key);
      const dist = conditionalAnswer(
        neighbours.map((p) => p.answers.get(it.itemKey)).filter((x): x is string => x !== undefined),
        people.map((p) => p.answers.get(it.itemKey)).filter((x): x is string => x !== undefined),
        keys,
        2,
      );
      const answer = drawKey(dist, rng);
      answers.push({
        itemKey: it.itemKey,
        prompt: it.prompt,
        options: it.options.map((o) => o.label),
        answer,
      });
    }
    return renderAgent(`${spec.seed}-${i + 1}`, facetsOut, readings, answers, items, facetById);
  });

  const synth = agents.map((a) => keptDims.map((id) => a.facets[id]!));
  const metrics = realism(keptDims, real, synth);
  const sensitiveIdx = keptDims.map((id, j) => ({ id, j })).filter(({ id }) => facetById.get(id)?.sensitive);
  const plainIdx = keptDims.map((_, j) => j).filter((j) => !facetById.get(keptDims[j]!)?.sensitive);
  const leak = sensitiveIdx.map(({ id, j }) => ({
    facet: id,
    real: people.length >= 8 && plainIdx.length ? leakR2(real, plainIdx, j) : null,
    synthetic: synth.length >= 8 && plainIdx.length ? leakR2(synth, plainIdx, j) : null,
  }));

  const doc: PopulationDoc = {
    schema: POPULATION_SCHEMA,
    createdAt: deps.clock(),
    seed: spec.seed,
    source: {
      people: people.length,
      split: spec.split,
      population: spec.population,
      datasetHash,
      minPeople: spec.minPeople,
    },
    dims: keptDims,
    fit: { weight: fit.weight, kappa: spec.kappa, k: spec.k },
    realism: metrics,
    leak,
    items: itemPeople.map(({ it, n }) => ({ itemKey: it.itemKey, people: n })),
    questionnaire: itemPeople
      .filter(({ it }) => it.facetIds.length === 1)
      .map(({ it }) => ({
        itemKey: it.itemKey,
        statement: it.prompt,
        choices: it.options.map((o) => o.label),
        dimension: it.facetIds[0]!,
        ascending: it.type === 'score',
      })),
    agents: shuffle(agents, seededRng(`${spec.seed}:order`)),
  };
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { ...spec, kind: 'population' },
    datasetHash,
    status: 'done',
    metrics: {
      people: people.length,
      agents: agents.length,
      dims: keptDims.length,
      items: itemPeople.length,
      fit: doc.fit,
      realism: metrics,
      leak,
    },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, doc };
}

/** Plain-text renderings for simulation engines, written from numbers and answers only: no model, no names. */
function renderAgent(
  id: string,
  facets: Record<string, number>,
  readings: Record<string, string>,
  answers: SyntheticAgent['answers'],
  items: Map<string, Item>,
  facetById: Map<string, Facet>,
): SyntheticAgent {
  const decisive = Object.entries(facets)
    .map(([fid, mean]) => ({ f: facetById.get(fid)!, mean, strength: Math.abs(mean - 0.5) }))
    .filter((x) => x.strength >= DECISIVE)
    .sort((a, b) => b.strength - a.strength || a.f.id.localeCompare(b.f.id));
  const tendency = (x: { f: Facet; mean: number }) => `${x.f.name}: ${readings[x.f.id]}`;
  const memories = [
    ...decisive.map(
      (x) => `On ${x.f.name.toLowerCase()}, they ${readings[x.f.id]} (${x.f.low} ↔ ${x.f.high}).`,
    ),
    ...answers.map((a) => {
      const it = items.get(a.itemKey)!;
      const label = it.options.find((o) => o.key === a.answer)?.label ?? a.answer;
      return `Asked "${a.prompt}", they chose "${label}".`;
    }),
  ];
  const top = decisive.slice(0, 5).map(tendency);
  const routine = facets.routine ?? 0.5;
  const social = facets.social_energy ?? 0.5;
  return {
    id,
    facets,
    readings,
    answers,
    concordia: {
      prefab: 'basic__Entity',
      params: {
        name: id,
        goal: top.length
          ? `Act as someone who ${top.map((t) => t.split(': ')[1]).join(', ')}.`
          : 'Act as themselves.',
      },
      memories,
    },
    smallville: {
      innate: top.join('; ') || 'no strong tendencies measured',
      learned: `Answered ${answers.length} typed questions about everyday decisions.`,
      currently: answers
        .slice(0, 3)
        .map(
          (a) =>
            `chose "${items.get(a.itemKey)!.options.find((o) => o.key === a.answer)?.label ?? a.answer}" when asked "${a.prompt}"`,
        )
        .join('; '),
      lifestyle: `${routine >= 0.6 ? 'Keeps structured routines' : routine <= 0.4 ? 'Keeps days spontaneous' : 'Mixes routine and spontaneity'}; ${
        social >= 0.6 ? 'recharges with people' : social <= 0.4 ? 'recharges alone' : 'recharges either way'
      }.`,
    },
  };
}

export function renderPopulation(m: Record<string, unknown>): string[] {
  const f3 = (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : '—');
  const r = m.realism as RealismMetrics | undefined;
  const fit = m.fit as { weight: number; kappa: number; k: number } | undefined;
  const out = [
    `People: ${String(m.people)} · agents: ${String(m.agents)} · facets: ${String(m.dims)} · items: ${String(m.items)}`,
    fit
      ? `Correlation weight ${f3(fit.weight)} (κ ${fit.kappa}); answers from the ${fit.k} nearest exemplars.`
      : '',
    '',
  ];
  if (r) {
    out.push(
      '| Metric | Value | Reads as |',
      '| --- | --- | --- |',
      `| Mean dispersion ratio | ${f3(r.meanDispersionRatio)} | 1 keeps the cohort's spread; below 1 is the under-dispersion twins show |`,
      `| Structure distance | ${f3(r.structureDistance)} | RMS difference of off-diagonal correlations, synthetic vs real |`,
      `| Coverage | ${f3(r.coverage)} | share of real people with a synthetic neighbour at least as close as any real one |`,
      `| Identifiability | ${f3(r.identifiability)} | share of real people a synthetic agent sits closer to than any other real person: near 1 copies people |`,
      '',
      '| Facet | Real mean | Real SD | Synthetic mean | Synthetic SD | Dispersion | Caricature |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...r.dims.map(
        (d) =>
          `| ${d.dim} | ${f3(d.realMean)} | ${f3(d.realSd)} | ${f3(d.synthMean)} | ${f3(d.synthSd)} | ${f3(d.dispersionRatio)} | ${f3(d.caricature)} |`,
      ),
      '',
    );
  }
  const leak = (m.leak as PopulationDoc['leak']) ?? [];
  if (leak.length) {
    out.push(
      '## Sensitive-facet leakage (cross-validated R² from the non-sensitive facets)',
      '',
      '| Facet | Real | Synthetic |',
      '| --- | --- | --- |',
    );
    for (const l of leak) out.push(`| ${l.facet} | ${f3(l.real)} | ${f3(l.synthetic)} |`);
    out.push('');
  }
  return out;
}
