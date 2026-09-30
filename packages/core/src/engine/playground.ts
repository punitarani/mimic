import { z } from 'zod';
import { argmax } from '../distribution';
import { generateRationale, scenarioToQuestion, validateDraft } from '../learning';
import { JevPredictor } from '../predictors';
import type { PredictionRecord, QuestionRecord } from '../store';
import type { Distribution } from '../types';
import { contextState, loadMimicData, sealedState, stateBlobKey } from './data';
import { ctxFor, type EngineDeps, EngineError, loadConfig, requireMimic } from './deps';
import { JEV_PROMPT_VERSION, type PublicQuestion, toPublic } from './session';

export const ScenarioInput = z.object({ scenario: z.string().trim().min(8).max(1000) });

export const DraftInput = z.object({
  type: z.enum(['choice', 'noul', 'score']),
  prompt: z.string().trim().min(5).max(300),
  options: z
    .array(z.object({ key: z.string(), label: z.string().trim().min(1).max(160) }))
    .min(2)
    .max(5),
  rationale: z.boolean().default(false),
});
export type DraftInput = z.infer<typeof DraftInput>;

/** Step 2 of PLAN §9.11: an LLM turns the scenario into a typed question the person can edit. */
export async function draftFromScenario(deps: EngineDeps, mimicId: string, scenario: string) {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (m.spendUsd >= cfg.session.budgetUsd) throw new EngineError('budget', 'Budget reached');
  const d = await scenarioToQuestion(deps.gateway, ctxFor(m, 'playground.draft'), {
    model: cfg.generator.model,
    scenario,
  });
  return { type: d.type, prompt: d.prompt, options: d.options };
}

export interface PlaygroundPrediction {
  question: PublicQuestion;
  dist: Distribution;
  guess: { optionKey: string; label: string; p: number };
  /** One generated sentence in the person's voice; always labeled "generated" in the UI. */
  rationale: string | null;
}

/**
 * Step 3: Jev predicts on the full state; the question is stored as `kind = playground` with sealed primary and
 * baseline predictions, so the person's own answer (step 4) is scored separately via the normal answer path.
 */
export async function predictPlayground(
  deps: EngineDeps,
  mimicId: string,
  input: DraftInput,
): Promise<PlaygroundPrediction> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (m.spendUsd >= cfg.session.budgetUsd) throw new EngineError('budget', 'Budget reached');
  const v = validateDraft({ ...input, domain: 'casual', facetIds: ['__pg'] }, new Set(['__pg']));
  if ('error' in v) throw new EngineError('invalid', `Invalid question: ${v.error}`);
  const loaded = await loadMimicData(deps, m);
  const seq = loaded.questions.reduce((a, q) => Math.max(a, q.seq ?? 0), 0) + 1;
  const now = deps.clock();
  const q: QuestionRecord = {
    id: deps.newId(),
    mimicId: m.id,
    seq: null,
    kind: 'playground',
    type: v.type,
    domain: 'casual',
    prompt: v.prompt,
    options: v.options,
    facetIds: [],
    provenance: { generator: 'playground', configHash: m.configHash, promptVersion: 'ask.v1' },
    status: 'pooled',
    quality: null,
    createdAt: now,
    servedAt: null,
  };
  await deps.store.insertQuestions([q]);
  const model = cfg.predictor.primary.replace(/^jev:/, '');
  const state = await sealedState(deps, loaded, cfg, seq, [q]);
  const base = contextState(loaded, cfg);
  const [[primary], [baseline]] = await Promise.all([
    new JevPredictor(deps.gateway, model, ctxFor(m, 'playground.predict')).predict(state, [q]),
    new JevPredictor(deps.gateway, model, ctxFor(m, 'playground.baseline')).predict(base, [q]),
  ]);
  if (!primary?.ok) throw new EngineError('conflict', 'The mimic could not predict this one. Try again.');
  const rec = (
    role: 'primary' | 'baseline',
    s: typeof state,
    r: NonNullable<typeof primary>,
  ): PredictionRecord => ({
    id: deps.newId(),
    questionId: q.id,
    mimicId: m.id,
    predictorId: cfg.predictor.primary,
    role,
    dist: r.dist,
    confidence: r.confidence ?? null,
    stateHash: s.meta.stateHash,
    evidenceSeqMax: s.meta.evidenceSeqMax,
    configHash: m.configHash,
    promptVersion: JEV_PROMPT_VERSION,
    modelSnapshot: r.modelSnapshot,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    ok: r.ok,
    error: r.error ?? null,
    fallback: false,
    createdAt: now,
  });
  const ok = await deps.store.serveQuestion({
    questionId: q.id,
    mimicId: m.id,
    seq,
    servedAt: now,
    predictions: [rec('primary', state, primary), rec('baseline', base, baseline!)],
  });
  if (!ok) throw new EngineError('conflict', 'Busy; try again');
  await deps.blobs.put(stateBlobKey(m.id, state.meta.stateHash), JSON.stringify(state), 'application/json');

  const key = argmax(primary.dist);
  const label = q.options.find((o) => o.key === key)?.label ?? key;
  let rationale: string | null = null;
  if (input.rationale) {
    rationale = await generateRationale(deps.gateway, ctxFor(m, 'playground.rationale'), {
      model: cfg.generator.model,
      state,
      prompt: q.prompt,
      optionLabel: label,
    }).catch(() => null);
  }
  return {
    question: toPublic({ ...q, seq, status: 'served' }),
    dist: primary.dist,
    guess: { optionKey: key, label, p: primary.dist[key] ?? 0 },
    rationale,
  };
}
