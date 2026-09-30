import {
  beliefAnswers,
  buildBelief,
  buildState,
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
}

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
 * while weakness comes from the sealed predictions made during the simulation, as it does online. Selection, weakness
 * and the reported accuracy all use Jev on its raw scale: what online selection reads under both cfg.default.v6 and
 * the calibrated v7 primary (`selectionView`, `rawScale`; ADR-0048), so selectors compare the same way for either.
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

  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const facets = await facetsFor(deps, m, cfg);
    const loaded = await loadMimicData(deps, m);
    const qById = new Map(loaded.questions.map((q) => [q.id, q]));
    const anchors = loaded.data.evidence.filter((e) => e.kind === 'anchor');
    const pool = loaded.data.evidence.filter((e) => e.kind === 'adaptive');
    for (const { label, selector: selCfg } of spec.selectors) {
      const selector = makeSelector(selCfg);
      for (const budget of spec.budgets) {
        if (pool.length <= budget) continue;
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
        }
        const state = stateFor([...anchors, ...chosen]);
        const targets = remaining.map((e) => qById.get(e.questionId)!);
        const preds = await primary.predict(state, targets);
        const accs = targets
          .map((q, i) => {
            const p = preds[i]!;
            const answer = remaining[i]!.answer;
            return p.ok ? scorePrediction(q.type, p.dist, answer).itemAcc : null;
          })
          .filter((x): x is number => x !== null);
        if (accs.length) {
          const k = keyOf(label, budget);
          acc.set(k, [...(acc.get(k) ?? []), accs.reduce((a, b) => a + b, 0) / accs.length]);
        }
      }
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
    metrics: { results },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, results };
}
