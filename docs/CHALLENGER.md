# span-01: the challenger to Jev

Respan's `respan/span-01` is being evaluated as a replacement for Jev (`typesafe/jev-1.13`). It is wired behind the
`decisions-model` flag and ships **off**. With the flag at `jev` (the default), every call runs exactly as before. The
decision to enable it follows the benchmark below, not a hunch (ADR-0050).

## What span-01 is

OpenRouter's model page (https://openrouter.ai/respan/span-01, checked 2026-09-30) describes it as follows:

- A structured decision model on the same **Decisions API** as Jev (`POST /api/alpha/decisions`). It answers
  `noul`, `choice` and `score` questions about a `state` and uses the same request and response shapes. The existing
  client (`JevDecisions` in `packages/adapters/src/openrouter.ts`) serves both, with the same timeout (15 s) and
  retries (2, on transient statuses).
- **Pinned** to the dated snapshot `respan/span-01-20260925` (`SPAN_MODEL`, `packages/core/src/config.ts`).
  `respan/span-01` resolves to the same endpoint.
- **Price:** $0.02 per million input tokens, and output is free. Jev costs $0.042/M input. Cost is always taken from
  the response's `usage.cost`, never hardcoded.
- **Parameters:** none. The endpoint lists no supported parameters, so there is no seed; both models are
  deterministic enough that `--repeat` measures the noise.
- **Account setting:** the model is served only by the provider `respan`. On 2026-09-30 this account's OpenRouter
  allowed providers excluded it, and every call returned 404 "No allowed providers" (recorded as
  `packages/adapters/fixtures/span-decisions-provider-blocked.json`). Add **Respan** at
  https://openrouter.ai/settings/privacy before benchmarking or enabling. Until then, the flag at `span-01` costs one
  fast 404 per call before Jev answers.

## How it is wired

- `Gateway.decide` (`packages/core/src/gateway.ts`) asks a router, `decisionChallenger`
  (`packages/core/src/challenger.ts`), which model to use. Call sites are unchanged: `JevPredictor`, the session, the
  playground and every other `decide` caller behave the same.
- Only requests for the incumbent `typesafe/jev-1.13` are rerouted, and only for the served-prediction purposes:
  `predict.primary`, `predict.baseline`, `select.bald`, `playground.predict` and `playground.baseline`.
  - Gates, trait reads and identity ranking stay on Jev, because their thresholds were tuned on Jev's probabilities.
  - Shadows, backfills and eval runs keep the model their predictor ID names.
- **Fallback:** if span-01 fails, the same request goes to Jev. A failure is an HTTP error after the adapter's
  retries, a timeout, a malformed response, or an answer missing for any question. Each attempt is its own
  `model_calls` row. A budget refusal is not retried.
- **Recording:** `modelSnapshot` on every prediction row names the model that answered, and the predictor ID stays the
  config's. A report that must separate the two models splits on `modelSnapshot`. To make span-01 the permanent
  primary, ship a new config (`cfg.default.v8`, primary `jev:respan/span-01-20260925@jev-predict.v2`) so the predictor
  IDs say so, then retire the flag.
- The primary's prompt and calibration (`jev-predict.v2`, temperature 4) apply to span-01's answers too. That
  temperature was fitted on Jev, so the benchmark measures span-01 both with it and raw.

## Flags

The flags live in the Cloudflare Flagship app `mimic` (prod) or `mimic-preview`, bound as `FLAGS` in both Workers.
Changes apply within seconds, with no redeploy.

| Flag | Values | Default | What it does |
| --- | --- | --- | --- |
| `decisions-model` | `jev`, `span-01` (or an OpenRouter Decisions model ID) | `jev` | The model incumbent Jev calls run on |
| `decisions-model-purposes` | Comma-separated call purposes | The five above | Which calls a non-Jev model may serve |

Flags are evaluated with `targetingKey` set to the mimic ID and `purpose` set to the call's purpose. A percentage
rollout therefore keeps each person on one model, for their primary and baseline alike.

### Enable

1. Allow the Respan provider on the OpenRouter account (see above), then run the benchmark and read its verdict.
2. In Flagship → `mimic` → `decisions-model` → Rules, add a rule that serves `span-01` to 10% (rollout on
   `targetingKey`). Save.
3. Watch `model_calls` for model `respan/span-01-20260925`: the error rate, and fallbacks (a failed span-01 row
   followed by a Jev row for the same job). Watch `/lab` for the primary's metrics split by `modelSnapshot`.
4. Raise the rollout step by step (10 → 50 → 100%), or set the default variation to `span-01`.

### Roll back

Set `decisions-model`'s default variation back to `jev` and delete its rules. The next request runs on Jev, with no
deploy. Turning the flag off (Enabled → off) also works, because a disabled flag serves its default variation.
If Flagship itself fails, reads return the code default (`jev`).

## Run the benchmark

The benchmark runs the production primary and the same predictor on span-01 over the same sealed instances, with no
flag and no fallback. It records each model's quality, latency per request (p50 and p95), cost per request and
error rate, and prints the verdict.

```
# 1. A fixed dataset: consented prod data (research consent only; ADR-0018), frozen as a file.
doppler run -- pnpm deploy:config --env prod
pnpm eval -- export --env prod --out data/bench.sqlite

# 2. One command (live calls; capped at --max-usd, default $1):
pnpm eval -- benchmark --data data/bench.sqlite

# Raw scale too (the calibration was fitted on Jev):
pnpm eval -- benchmark --data data/bench.sqlite --incumbent jev:typesafe/jev-1.13
```

- **Inputs:** held-out people (`--split test`, never used to fit the calibration) at checkpoint `--k 30`. Up to 40
  targets per person, sampled with `--seed benchmark`.
- **Outputs:** in `data/benchmark/<run>/`: `benchmark.md` (the side-by-side table and verdict), `benchmark.csv`,
  `benchmark.json` and `records.jsonl` (per prediction).
- **Reproducibility:** the dataset hash, split, seed and both models' returned snapshots are in the report. The same
  file and seed select the same instances. Neither model takes a seed; add `--repeat` to `evaluate` to see the noise.
- **Cost:** with a few hundred predictions batched per person, a run costs well under $0.05. `--offline` runs the
  harness with fake providers for free (numbers meaningless).
- A public alternative with real people is the Twin-2K-500 dataset:
  `pnpm eval -- import twin2k500 --path <file> --out data/twin.sqlite`, then `--data data/twin.sqlite`. The bundled
  `packages/eval/fixtures/twin2k500.sample.jsonl` is fictional. Use it only to check that the harness runs.

### Decision rule

Enable span-01 only if it **beats Jev on quality** without an unacceptable regression. Every check must pass
(`DECISION_RULE`, `packages/eval/src/benchmark.ts`):

| Check | Passes when |
| --- | --- |
| Enough data | At least 200 paired predictions from at least 5 people |
| Better log loss | The paired bootstrap interval of log loss (span-01 − Jev) lies entirely below 0 |
| Accuracy held | Item accuracy is no more than 1 point lower |
| Error rate | At most 1 point above Jev's (each error means a fallback, so both calls' latency) |
| Latency | p50 and p95 per request at most 1.5× Jev's |
| Cost | Per answered request, at most 1.5× Jev's |

Log loss is the headline metric because the stored predictions are probability distributions (PLAN §12). Failed
predictions count as uniform. A model that never answered fails the latency and cost checks.

### Harness check (2026-09-30)

A live run on the six fictional people of the bundled sample (`--split all --k 8`, 30 predictions, $0.0004 in
total) confirmed the harness end to end:

- Jev answered every request: p50 719 ms, p95 810 ms, $0.000059 per request.
- span-01 errored on all 30 predictions with the provider-allowlist 404, and the verdict was "keep Jev".

These are not results. The people are fictional and span-01 could not be reached.
