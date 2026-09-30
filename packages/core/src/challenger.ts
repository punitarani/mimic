import { JEV_MODEL } from './config';
import { decisionModelOf, FLAG_SPECS, type FlagReader } from './flags';
import type { CallContext } from './gateway';
import type { DecisionRequest, DecisionResponse } from './types';

/**
 * Picks the model a decision call runs on (ADR-0051): the challenger's model ID, or null to run the request as it
 * is. The Gateway calls it before every `decide`, so call sites never change.
 */
export type DecisionRouter = (ctx: CallContext, req: DecisionRequest) => Promise<string | null>;

/**
 * The purposes a challenger may serve: the served predictions (primary, baseline, selection's scoring, the
 * playground's pair). Gates, trait reads and identity ranking stay on Jev: their thresholds were tuned on Jev's
 * probabilities (ADR-0015, ADR-0042), so widening this is a reviewed change. Shadows, backfills and eval calls name
 * their model explicitly and are never rerouted, since the model is part of the predictor ID they store.
 */
export const CHALLENGER_PURPOSES = [
  'predict.primary',
  'predict.baseline',
  'select.bald',
  'playground.predict',
  'playground.baseline',
] as const;

/**
 * A router over the `decisions-model` flag. Only requests for the incumbent Jev model, for the served purposes, are
 * candidates. The flag is evaluated with the mimic as its targeting key (so a percentage rollout keeps each person on
 * one model for primary and baseline alike) and the purpose as an attribute (so Flagship rules can narrow the
 * purposes further). With the flag at `jev`, one flag read is the only difference from having no router.
 */
export function decisionChallenger(flags: FlagReader, incumbent: string = JEV_MODEL): DecisionRouter {
  const spec = FLAG_SPECS.decisionsModel;
  return async (ctx, req) => {
    if (req.model !== incumbent || !(CHALLENGER_PURPOSES as readonly string[]).includes(ctx.purpose))
      return null;
    const fctx = { targetingKey: ctx.mimicId ?? 'none', purpose: ctx.purpose };
    const model = decisionModelOf(await flags.string(spec.key, spec.fallback, fctx));
    return model && model !== incumbent ? model : null;
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
