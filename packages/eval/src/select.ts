import {
  beliefAnswers,
  buildBelief,
  buildState,
  type Category,
  type EngineDeps,
  type EvalRunRecord,
  type EvidenceItem,
  facetsFor,
  type ItemStatRecord,
  JEV_MODEL,
  JevPredictor,
  lexicalSimilarity,
  loadConfig,
  loadMimicData,
  makeSelector,
  type PipelineConfig,
  populationScore,
  type QuestionRecord,
  questionCoverage,
  questionsToSustain,
  scorePrediction,
  seededRng,
  shuffle,
  stateOptions,
  ulid,
} from '@mimic/core';

export interface SelectSpec {
  name: string;
  /** One or more selectors run on the same people and budgets, reported side by side. */
  selectors: Array<{ label: string; selector: PipelineConfig['selector'] }>;
  budgets: number[];
  split: 'dev' | 'test' | 'all';
  limitPeople?: number;
  seed: string;
  /** `voi` only: use the data file's `item_stats` (default) or run without population statistics. */
  population?: boolean;
  /**
   * Record accuracy on the rest after every pick up to the largest budget (ADR-0044), so questions to sustained
   * accuracy and accuracy at a budget can be compared per selector on the same people.
   */
  series?: boolean;
  /**
   * Simulate a person who selected only these of their categories: facets, anchors and pool are restricted to them.
   * Intersected with each person's own selection, so a category they turned off is never turned back on.
   */
  categories?: Category[];
}

export interface SeriesPoint {
  selector: string;
  k: number;
  people: number;
  accuracy: number | null;
}

/** Accuracy on the rest that counts as sustained, as `questionsToSustain` reads fidelity in the lab (E3). */
export const SUSTAIN_TARGET = 0.75;

export interface SelectResult {
  selector: string;
  budget: number;
  people: number;
  accuracy: number | null;
}

/**
 * `mimic-eval select` (PLAN §12.2): pool-restricted selection simulation. Each person's already answered adaptive
 * questions form the pool; starting from their anchors, the selector picks `budget` questions (their real answers
 * are revealed), then the remaining pool is predicted and scored. Biased (the pool was itself selected online);
 * use for iteration only. States use the `raw` strategy so derived traits/insights from the full history never leak.
 * For `voi`, the belief state is rebuilt from the simulated evidence alone: no trait reads, so uncertainty stays 1,
 * while weakness comes from the sealed predictions made during the simulation, as it does online.
 */
export async function simulateSelection(deps: EngineDeps, spec: SelectSpec, datasetHash: string) {
  const all = await deps.store.listMimics({ consentResearch: true });
  const mimics = shuffle(
    all.filter((m) => spec.split === 'all' || m.split === spec.split),
    seededRng(spec.seed),
  ).slice(0, spec.limitPeople);
  const primary = new JevPredictor(deps.gateway, JEV_MODEL, { purpose: 'eval.select' });
  const stats = new Map<string, ItemStatRecord>(
    spec.population === false ? [] : (await deps.store.listItemStats()).map((s) => [s.key, s]),
  );
  const acc = new Map<string, number[]>();
  const keyOf = (label: string, budget: number) => `${label}|${budget}`;
  const series = new Map<string, number[]>();
  /** Per selector, per person: the first k from which accuracy on the rest stays ≥ 0.75, or null. */
  const sustain = new Map<string, Array<number | null>>();
  const maxBudget = Math.max(...spec.budgets);

  for (const m0 of mimics) {
    // Narrows the person's own categories, never widens them: a category they turned off stays off, so the answers
    // their scope hides never reach a state or a model (ADR-0040).
    const m = spec.categories
      ? {
          ...m0,
          scope: { ...m0.scope, categories: m0.scope.categories.filter((c) => spec.categories!.includes(c)) },
        }
      : m0;
    const cfg = await loadConfig(deps, m.configHash);
    const facets = await facetsFor(deps, m, cfg);
    const allowed = new Set(facets.map((f) => f.id));
    const inScope = (e: EvidenceItem) => !spec.categories || e.facetIds.every((f) => allowed.has(f));
    const loaded = await loadMimicData(deps, m);
    const qById = new Map(loaded.questions.map((q) => [q.id, q]));
    const anchors = loaded.data.evidence.filter((e) => e.kind === 'anchor' && inScope(e));
    const pool = loaded.data.evidence.filter((e) => e.kind === 'adaptive' && inScope(e));
    for (const { label, selector: selCfg } of spec.selectors) {
      const selector = makeSelector(selCfg);
      for (const budget of spec.series ? [maxBudget] : spec.budgets) {
        if (pool.length <= budget) continue;
        const trace: number[] = [];
        const rng = seededRng(`${spec.seed}:${label}:${m.id}:${budget}`);
        const chosen: EvidenceItem[] = [];
        const itemAccByQuestion = new Map<string, number>();
        let remaining = [...pool];
        const counts = new Map<string, number>();
        for (const e of anchors) for (const f of e.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
        const stateFor = (evidence: EvidenceItem[]) =>
          buildState(
            { ...loaded.data, evidence, traits: [], insights: [] },
            stateOptions(cfg, Number.MAX_SAFE_INTEGER, { strategy: 'raw' }),
          );
        const beliefFor = (evidence: EvidenceItem[]) => {
          // The same answer mapping the engine uses (engine/belief.ts), over the answers revealed so far.
          const revealed = new Set(evidence.map((e) => e.questionId));
          const answers = beliefAnswers(
            loaded.answers.filter((a) => revealed.has(a.questionId)),
            qById,
            itemAccByQuestion,
          );
          return buildBelief({
            facets,
            answers,
            traits: [],
            insights: [],
            repeats: [],
            domainMix: cfg.generator.domainMix,
          });
        };
        while (chosen.length < budget) {
          const evidence = [...anchors, ...chosen];
          const state = stateFor(evidence);
          const candidates = remaining.map((e) => qById.get(e.questionId)!) as QuestionRecord[];
          const sel = await selector.select({
            pool: candidates,
            state,
            primary,
            coverage: (q) => questionCoverage(counts, q),
            redundancy: (q) => Math.max(0, ...chosen.map((c) => lexicalSimilarity(q.prompt, c.prompt))),
            rng,
            sessionTarget: cfg.session.target,
            seq: evidence.length + 1,
            ...(selCfg.type === 'voi'
              ? {
                  belief: beliefFor(evidence),
                  population: (q) => (stats.size ? populationScore(q, stats) : null),
                }
              : {}),
          });
          const picked = remaining.find((e) => e.questionId === sel.question.id)!;
          // The sealed prediction of the chosen question is scored against the real answer, as online, so the
          // belief's weakness term sees the same prequential signal.
          if (sel.primary.ok)
            itemAccByQuestion.set(
              picked.questionId,
              scorePrediction(sel.question.type, sel.primary.dist, picked.answer).itemAcc,
            );
          chosen.push(picked);
          for (const f of picked.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
          remaining = remaining.filter((e) => e !== picked);
          if (spec.series) {
            const a = await accuracyOnRest([...anchors, ...chosen], remaining);
            // No scored prediction is no evidence of fidelity: it counts as below the target, never as sustained
            // (`questionsToSustain` only looks for values under it, and NaN is never under anything).
            trace.push(a ?? 0);
            const key = keyOf(label, chosen.length);
            if (a !== null) series.set(key, [...(series.get(key) ?? []), a]);
            if (spec.budgets.includes(chosen.length) && a !== null)
              acc.set(key, [...(acc.get(key) ?? []), a]);
          }
        }
        if (spec.series) {
          sustain.set(label, [...(sustain.get(label) ?? []), questionsToSustain(trace, SUSTAIN_TARGET)]);
          continue;
        }
        const a = await accuracyOnRest([...anchors, ...chosen], remaining);
        if (a !== null) {
          const k = keyOf(label, budget);
          acc.set(k, [...(acc.get(k) ?? []), a]);
        }
      }
    }

    async function accuracyOnRest(evidence: EvidenceItem[], rest: EvidenceItem[]): Promise<number | null> {
      const state = buildState(
        { ...loaded.data, evidence, traits: [], insights: [] },
        stateOptions(cfg, Number.MAX_SAFE_INTEGER, { strategy: 'raw' }),
      );
      const targets = rest.map((e) => qById.get(e.questionId)!);
      const preds = await primary.predict(state, targets);
      const accs = targets
        .map((q, i) => {
          const p = preds[i]!;
          return p.ok ? scorePrediction(q.type, p.dist, rest[i]!.answer).itemAcc : null;
        })
        .filter((x): x is number => x !== null);
      return accs.length ? accs.reduce((x, y) => x + y, 0) / accs.length : null;
    }
  }
  const results: SelectResult[] = spec.selectors.flatMap(({ label }) =>
    spec.budgets.map((b) => {
      const xs = acc.get(keyOf(label, b)) ?? [];
      return {
        selector: label,
        budget: b,
        people: xs.length,
        accuracy: xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null,
      };
    }),
  );
  const seriesOut: SeriesPoint[] = spec.series
    ? spec.selectors.flatMap(({ label }) =>
        Array.from({ length: maxBudget }, (_, i) => {
          const xs = series.get(keyOf(label, i + 1)) ?? [];
          return {
            selector: label,
            k: i + 1,
            people: xs.length,
            accuracy: xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null,
          };
        }),
      )
    : [];
  const sustained = spec.series
    ? spec.selectors.map(({ label }) => {
        const ks = sustain.get(label) ?? [];
        const reached = ks.filter((k): k is number => k !== null);
        return {
          selector: label,
          people: ks.length,
          reached: reached.length,
          meanQuestions: reached.length ? reached.reduce((a, b) => a + b, 0) / reached.length : null,
        };
      })
    : [];
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: {
      ...spec,
      kind: 'select',
      populationStats: stats.size,
      note: 'pool-restricted simulation; biased, iteration only',
    },
    datasetHash,
    status: 'done',
    metrics: { results, ...(spec.series ? { series: seriesOut, sustained, target: SUSTAIN_TARGET } : {}) },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, results };
}
