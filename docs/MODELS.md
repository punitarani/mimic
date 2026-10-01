# E8: decision models compared

v1 · 2026-10-01 · Status: run on 2026-10-01 (Actions run `36926382050`, eval run `01M3WP08Q7MSSY0772PRNCQE27`, $2.00).
Verdict: keep Jev. Readout: `docs/reports/e8-models.md`. ADR-0068. The rule in §5 was fixed before the first run.

E8 asks which decision model predicts a person best. Jev is Mimic's primary. span-01 is the challenger behind the
`decisions-model` flag (ADR-0051). Cloudflare's clef and clef-flash, and Perplexity's decider, were released this week
and take the same request.

Every model answers the same sealed instances, from the same state, in the same requests, so this is a paired
experiment that needs no new people. It costs a few dollars and runs in one workflow.

## 1. Why this experiment

- **Same API, different models.** All five take a state and named `noul` / `choice` / `score` questions, and return a
  probability per option. Clef's model card says its API is "fully compatible with Jev and SystemOne", and
  Perplexity's matches field for field. Mimic can therefore ask all five the same question in the same words.
  Prompts, states and batching then cancel out, and only the model differs.
- **Jev's limits are known.** E6 found that Jev learns from Twin's survey answers but not from Mimic's served ones
  (`docs/reports/e6-evidence.md`). The span-01 benchmark has no published result yet. A model that learns from served
  answers, or that knows the population better, would change the primary.
- **The challengers are cheap enough to serve.** At Mimic's state sizes, every model costs about $0.001 per request or
  less (§2).

## 2. The models

| Model | Mimic ID | Served by | Size | Price (input; output free) | Limits | Snapshot |
| --- | --- | --- | --- | --- | --- | --- |
| Jev | `typesafe/jev-1.13` | OpenRouter Decisions API | — | $0.042/M, from `usage.cost` | 32K context | dated (`…-20260917`) |
| span-01 | `respan/span-01-20260925` | OpenRouter Decisions API | — | $0.02/M, from `usage.cost` | string state, yes/no only (choice and score asked one option at a time, ADR-0051) | dated |
| clef | `cloudflare/clef` | Cloudflare Workers AI | 27B | $0.24/M, list rate | 64K context, 64 questions a request | none |
| clef-flash | `cloudflare/clef-flash` | Cloudflare Workers AI | 9B | $0.09/M, list rate | 64K context, 64 questions a request | none |
| Perplexity's decider | `perplexity/pplx-decider-v1-27b` | Perplexity API | 27B | $0.04/M, list rate | 262K tokens, 128 questions a request | none |

**IDs and wiring.**
- Mimic's model IDs are provider-neutral, with the vendor as a prefix, because `@` separates a predictor's prompt
  version. The adapter turns `cloudflare/clef` into Workers AI's `@cf/cloudflare/clef`.
- One decision provider routes each model to its vendor (`RoutedDecisions`, `packages/adapters/src/decisions.ts`).
  Each `model_calls` row names the vendor that served the call.

**Prices.**
- Workers AI and Perplexity return token counts but no cost. Their calls are priced at the published list rate,
  registered with its source and date in `DECISION_LIST_RATES`. This is the one exception to "money is the
  provider's `usage.cost`" (ADR-0068).
- **Snapshot.** Neither vendor has a dated snapshot, so a result holds for the day it was measured.

### Keys the run needs

| Key | For | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Jev, span-01 | Already set. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | clef, clef-flash | The deploy token, with **Account · Workers AI · Read** added (`docs/DEPLOY.md`). |
| `PERPLEXITY_API_KEY` | Perplexity's decider | Any Perplexity API key; the same secret the optional people-search adapter reads. |

A canary request per model runs first, and names the fix when a key or permission is missing. By default a failed
canary stops the run before anything else is spent. With `--drop-failed-canary` (the workflow's setting) only that
model is left out.

## 3. Questions and hypotheses

1. **Quality.** Does any challenger beat Jev on calibrated log loss on served questions, without losing accuracy,
   and not get worse on Twin? The null hypothesis is no.
2. **Learning.** Which models learn from the person? This is `full` against `context` for the same model. E6 says Jev
   learns on Twin and not on served questions. A model that learns on both is worth more than one that only has a
   better prior.
3. **Question types.** Do the models differ by question type? span-01's split of choice and score questions into
   yes/no questions is an approximation (ADR-0051), and the other models answer all three types natively.
4. **Operations.** Errors, latency per request, and cost per request and per 1,000 predictions.

## 4. Design

**Data**, each set used for what it can show.

- **Served questions (Mimic).**
  - Every answered anchor and adaptive question from the consented prod export (ADR-0018). The state is rebuilt as
    served and sealed below the question (invariant 1).
  - Real people only (`--population real`). Scripted and imported people are never results.
  - `--split all`: nothing in E8 is fitted on one split and scored on the other, and calibration leaves each person
    out (below).
  - The verdict is read here.
- **Twin-2K-500 (subset).**
  - The first `twin_people` people of the Hugging Face dataset (200 by default). Their first k = 30 wave 1–3 answers
    form the state; up to 20 of their wave 4 answers, chosen with a seed, are the targets.
  - This is survey data from real people with a large evidence base. It replicates the served result, and it is where
    learning from answers is measurable. It never stands in for a Mimic result (`docs/RESEARCH.md` §8).

**Arms.**
- **Models.** Five, on the raw scale, with no prompt version. Every arm uses the incumbent prompt, so the arms differ
  only by model. The first predictor, Jev, is the reference.
  - Jev's production temperature (T = 4) was fitted on Jev, so applying it to every model would favour Jev. The report
    still shows Jev at T = 4, computed from its raw records for free, beside the others.
- **Views.** Each model predicts from `full` (the state as served) and from `context` (identity only, the baseline's
  view), using `viewState` (ADR-0053). Where a state holds no answers yet, the two views are the same state, and the
  `context` arm reuses the `full` prediction.

**Requests.** Every model answers exactly the same requests; latency and cost are per request.
- **Served questions go one per request, in both views.** Each served state is built for its question, so `full` can't
  batch, and asking `context` the same way keeps lift free of batch effects (as E6 does).
- **Twin's targets share a person's state** and go in batches of `--max-questions` (20), never above what any model
  takes (clef 64, the decider 128).

**Answers.**
- A response from another model, or one that can't be read, fails its whole request, and its cost is kept.
- A single malformed answer fails only its own question. Malformed means the wrong type, a choice outside the options,
  or score levels not keyed `0..n-1`; read anyway, it would score as near-uniform yet count as answered.
- Either way the failure counts as the model's (errors, log loss), it is not retried, and the trace keeps the raw
  response.

**Order and spend.**
- **Canary.** One synthetic request per model (a yes/no, a choice and a score question) runs first. It checks that
  every question is answered, with choice keys among the options and score levels keyed `0..n-1`. Any failure stops
  the run. `canary.json` keeps the synthetic requests and raw responses, from which the adapter fixtures are
  re-recorded.
- **Chunks.** People run in chunks of `--chunk-people` (10), served questions first. Each chunk runs every model and
  view, with the models side by side.
- **Budget stop.** If a budget stop cuts a chunk, the chunk is dropped for every model, so no model keeps a different
  subset. A chunk the cap would likely cut is not started.
- **Cap.** `--max-usd`, 5 by default. The whole run should cost about $2.

**Calibration.**
- Each model gets one temperature per dataset and view, chosen on everyone else's predictions (leave one person out)
  from a 46-step grid between 0.25 and 16, plus 1.
- Every person is scored by a temperature their own answers didn't choose. The fit needs no split and no seed, so it
  survives an export's pseudonymous IDs.
- This puts the models on equal terms: every served predictor gets a temperature, and the probabilities each model
  returns differ in scale.

## 5. Decision rule (`MODELS_RULE`, `packages/eval/src/models.ts`)

The rule compares each challenger against Jev on log loss after the leave-one-person-out temperature, in the `full`
view. Intervals are 90% (5th–95th percentile, 2,000 seeded resamples). The served interval resamples questions, since
there are few people; Twin's resamples people. This is how E6 reads them.

| Outcome | When |
| --- | --- |
| `insufficient` | Fewer than 200 served predictions from 5 real people, or fewer than 30 Twin people at k = 30 |
| `worse` | The served interval or the Twin interval lies entirely above 0 |
| `better` | The served interval lies entirely below 0, the Twin mean is at most 0, and item accuracy drops by at most 1 point on both |
| `level` | Anything else |

**Operational checks** are listed beside the outcome:
- error rate at most 1 point above Jev's;
- p50 and p95 latency per request at most 1.5× Jev's;
- cost is reported, not gated. Clef's rate is 5.7× Jev's, but every model costs about $0.001 a request or less. The
  follow-up ADR weighs cost against the per-mimic budget.

**Recommendation.** A challenger that is `better` and passes every operational check is recommended for a shadow. If
several are, the one with the lowest served log loss is recommended. A recommendation leads to a new config with the
model as a shadow, then `pnpm backfill` on served questions (ADR-0024), in its own ADR. Becoming the primary would
come later, from the shadow's stored rows. If no challenger is recommended, Jev stays.

## 6. Metrics

Each is reported per dataset × model × view:

- **Quality:** log loss raw and after the temperature (with the T fitted on everyone, for reference), item accuracy,
  top-1, Brier and ECE.
- **Failures and cost:** failed predictions, which count as uniform; cost per 1,000 predictions; the snapshot.
- **On `full`:** p50 and p95 latency per request, and cost per request.
- **Against Jev:** Δ log loss with intervals by person and by question, Δ item accuracy, people better and worse, and Δ
  raw log loss.
- **Learning:** `full` − `context` for each model.
- **Pairwise:** a matrix of Δ log loss between all five models.
- **By question type:** quality per type, since span-01 answers choice and score questions one option at a time.

## 7. What it can't show

- **Few served people.** Served questions come from about six consented people, so the served interval is by question
  and the people count is a floor rather than power. The verdict needs Twin to agree in direction.
- **No snapshots.** Clef and Perplexity's decider can change under the same name, so the report records the run date.
- **One prompt.** Every model is asked in Jev's words, and the harness's components were tuned on Jev. A challenger's
  best prompt could do better, and that would be its own optimization run (`docs/OPTIMIZATION.md`).
- **Latency is measured from the runner.** OpenRouter, Cloudflare and Perplexity sit at different network distances
  from a GitHub runner, so production latency could differ.
- **Same state for all.** Clef reads 64K tokens and the decider 262K. Neither is given a bigger state here, by choice:
  more context is a separate experiment.

## 8. Running it

**In CI (the usual way, after merge):** Actions → **Decision models** → Run workflow.
- **Inputs:** `data` (prod, twin or both; the verdict needs both), `twin_people` (200), `predictors` (empty means all
  five), `max_usd` (5), `publish` (to `/lab`).
- **Outputs:** the readout lands in the step summary and in `/lab`. The artifact holds `report.md` and `canary.json`,
  and the log prints the canary. Per-question records stay on the runner.
- **A failed canary.** The workflow passes `--drop-failed-canary`, so a model whose canary fails is left out and named
  in the report, and the others still run. The reference (Jev) must pass, and at least one challenger must remain.

**Locally:**

```
doppler run -- pnpm deploy:config --env prod
pnpm eval -- export --env prod --out data/prod.sqlite                  # consented people only (ADR-0018)
pnpm eval -- import twin2k500 --path data/twin.jsonl --out data/twin.sqlite
pnpm eval -- models --data data/prod.sqlite,data/twin.sqlite           # live, capped at --max-usd (default $5)
pnpm eval -- models --data data/twin.sqlite --offline --population all --k 8   # the harness, free, meaningless numbers
```

`--predictors` takes any decision predictors that share a prompt version, the reference first. For example,
`decision:typesafe/jev-1.13,decision:cloudflare/clef` runs a two-model run.

**After a live run:** re-record the adapter fixtures from `canary.json` if a vendor's response shape changed
(`packages/adapters/fixtures/README.md`), and update `docs/reports/e8-models.md`. The first run's canary is the current
fixture set.
