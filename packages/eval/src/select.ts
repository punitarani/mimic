import {
  buildState,
  type EngineDeps,
  type EvalRunRecord,
  type EvidenceItem,
  JEV_MODEL,
  JevPredictor,
  lexicalSimilarity,
  loadConfig,
  loadMimicData,
  makeSelector,
  type PipelineConfig,
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
  selector: PipelineConfig['selector'];
  budgets: number[];
  split: 'dev' | 'test' | 'all';
  limitPeople?: number;
  seed: string;
}

/**
 * `mimic-eval select` (PLAN §12.2): pool-restricted selection simulation. Each person's already answered adaptive
 * questions form the pool; starting from their anchors, the selector picks `budget` questions (their real answers
 * are revealed), then the remaining pool is predicted and scored. Biased (the pool was itself selected online);
 * use for iteration only. States use the `raw` strategy so derived traits/insights from the full history never leak.
 */
export async function simulateSelection(deps: EngineDeps, spec: SelectSpec, datasetHash: string) {
  const all = await deps.store.listMimics({ consentResearch: true });
  const mimics = shuffle(
    all.filter((m) => spec.split === 'all' || m.split === spec.split),
    seededRng(spec.seed),
  ).slice(0, spec.limitPeople);
  const selector = makeSelector(spec.selector);
  const primary = new JevPredictor(deps.gateway, JEV_MODEL, { purpose: 'eval.select' });
  const byBudget = new Map<number, number[]>();

  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const loaded = await loadMimicData(deps, m);
    const qById = new Map(loaded.questions.map((q) => [q.id, q]));
    const anchors = loaded.data.evidence.filter((e) => e.kind === 'anchor');
    const pool = loaded.data.evidence.filter((e) => e.kind === 'adaptive');
    for (const budget of spec.budgets) {
      if (pool.length <= budget) continue;
      const rng = seededRng(`${spec.seed}:${m.id}:${budget}`);
      const chosen: EvidenceItem[] = [];
      let remaining = [...pool];
      const counts = new Map<string, number>();
      for (const e of anchors) for (const f of e.facetIds) counts.set(f, (counts.get(f) ?? 0) + 1);
      const stateFor = (evidence: EvidenceItem[]) =>
        buildState(
          { ...loaded.data, evidence, traits: [], insights: [] },
          stateOptions(cfg, Number.MAX_SAFE_INTEGER, { strategy: 'raw' }),
        );
      while (chosen.length < budget) {
        const state = stateFor([...anchors, ...chosen]);
        const candidates = remaining.map((e) => qById.get(e.questionId)!) as QuestionRecord[];
        const sel = await selector.select({
          pool: candidates,
          state,
          primary,
          coverage: (q) => questionCoverage(counts, q),
          redundancy: (q) => Math.max(0, ...chosen.map((c) => lexicalSimilarity(q.prompt, c.prompt))),
          rng,
        });
        const picked = remaining.find((e) => e.questionId === sel.question.id)!;
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
      if (accs.length)
        byBudget.set(budget, [
          ...(byBudget.get(budget) ?? []),
          accs.reduce((a, b) => a + b, 0) / accs.length,
        ]);
    }
  }
  const results = spec.budgets.map((b) => {
    const xs = byBudget.get(b) ?? [];
    return {
      budget: b,
      people: xs.length,
      accuracy: xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null,
    };
  });
  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { ...spec, kind: 'select', note: 'pool-restricted simulation; biased, iteration only' },
    datasetHash,
    status: 'done',
    metrics: { results },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, results };
}
