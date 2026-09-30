import { JEV_MODEL, SPAN_MODEL } from './config';
import { FLAG_KEYS, type FlagReader } from './flags';
import type { CallContext } from './gateway';
import type { DecisionRequest, DecisionResponse } from './types';

/**
 * Picks the model a decision call runs on (ADR-0050): the challenger's model ID, or null to run the request as it
 * is. The Gateway calls it before every `decide`, so call sites never change.
 */
export type DecisionRouter = (ctx: CallContext, req: DecisionRequest) => Promise<string | null>;

/**
 * The purposes a challenger may serve by default: the served predictions (primary, baseline, selection's scoring,
 * the playground's pair). Gates, trait reads and identity ranking stay on Jev: their thresholds were tuned on Jev's
 * probabilities (ADR-0015, ADR-0042). Shadows, backfills and eval calls name their model explicitly and are never
 * rerouted, since the model is part of the predictor ID they store.
 */
export const CHALLENGER_PURPOSES = [
  'predict.primary',
  'predict.baseline',
  'select.bald',
  'playground.predict',
  'playground.baseline',
] as const;

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/**
 * The `decisions-model` variants and the pinned model each serves. A variant names a model here rather than in the
 * flag, so changing what `span-01` means is a reviewed code change, not a dashboard edit.
 */
export const DECISION_MODELS: Readonly<Record<string, string>> = {
  jev: JEV_MODEL,
  'span-01': SPAN_MODEL,
};

/**
 * The model a `decisions-model` value names: a variant of DECISION_MODELS (case and spacing ignored, so a label such
 * as "Span-01" works), or an OpenRouter Decisions model ID. Null for anything else, which leaves Jev in place.
 */
export function decisionModelOf(value: string): string | null {
  const v = value.trim();
  const key = v.toLowerCase().replace(/[\s_]+/g, '-');
  if (Object.hasOwn(DECISION_MODELS, key)) return DECISION_MODELS[key]!;
  return MODEL_ID.test(v) ? v : null;
}

/**
 * A router over the `decisions-model` flags. Only requests for the incumbent Jev model are candidates; the flag is
 * evaluated with the mimic as its targeting key (so a percentage rollout keeps each person on one model for primary
 * and baseline alike) and the purpose as an attribute (so Flagship rules can target purposes too). With the flag at
 * `jev`, one flag read is the only difference from having no router.
 */
export function decisionChallenger(flags: FlagReader, incumbent: string = JEV_MODEL): DecisionRouter {
  return async (ctx, req) => {
    if (req.model !== incumbent) return null;
    const fctx = { targetingKey: ctx.mimicId ?? 'none', purpose: ctx.purpose };
    const model = decisionModelOf(await flags.string(FLAG_KEYS.decisionsModel, 'jev', fctx));
    if (!model || model === incumbent) return null;
    const purposes = await flags.string(
      FLAG_KEYS.decisionsModelPurposes,
      CHALLENGER_PURPOSES.join(','),
      fctx,
    );
    return purposes.split(',').some((p) => p.trim() === ctx.purpose) ? model : null;
  };
}

/**
 * The questions a response leaves unanswered or answers with the wrong type. A challenger's response with any is a
 * failure (the Gateway falls back to the incumbent), not a partial answer the predictor would record as errors.
 */
export function unansweredQuestions(req: DecisionRequest, res: Pick<DecisionResponse, 'answers'>): string[] {
  return Object.entries(req.questions)
    .filter(([key, q]) => res.answers[key]?.type !== q.type)
    .map(([key]) => key);
}
