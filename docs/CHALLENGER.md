# span-01: the challenger to Jev

Respan's `respan/span-01` is being evaluated as a replacement for Jev (`typesafe/jev-1.13`) in served predictions.
It sits behind the Flagship flag `decisions-model` and ships at `jev`: at that value (or with the flag missing or
unreadable) every call runs exactly as before. The decision to switch follows the benchmark below (ADR-0050).

## What span-01 is

The model page is https://openrouter.ai/respan/span-01. Live calls on 2026-09-30 corrected parts of it:

- **Same API.** It runs on OpenRouter's **Decisions API**, as Jev does (`POST /api/alpha/decisions`), so the Jev
  client (`JevDecisions`) serves it with the same timeout (15 s) and retries (2, on transient statuses).
- **Pinned.** `SPAN_MODEL = respan/span-01-20260925`, the dated snapshot. `respan/span-01` resolves to it.
- **Price.** $0.02 per million input tokens, and output is free; Jev is $0.042/M. Cost is always read from the
  response's `usage.cost`.
- **Parameters.** None, so there is no seed.
- **Limits** (not on the model page; its generic example shows question types span-01 refuses). span-01 is a
  behaviour scorer, and answers anything else with HTTP 400 (recorded fixtures):
  - `state` must be a string (or an `{input, output}` message conversation). Jev's JSON object state is refused.
  - Only `noul` (yes/no) questions. `choice` and `score` are refused.
- **Provider.** It is served only by the provider `respan`, which must be allowed in the OpenRouter account's
  provider settings (https://openrouter.ai/settings/privacy). It is allowed now; while it wasn't, every call returned
  a 404 "No allowed providers".

## How it is wired

- **Routing.** `Gateway.decide` (`packages/core/src/gateway.ts`) asks a router, `decisionChallenger`
  (`packages/core/src/challenger.ts`), which model to use. No call site changes: `JevPredictor`, the session, the
  playground and every other `decide` caller behave the same.
  - Only requests for the incumbent `typesafe/jev-1.13` are rerouted, and only for the served-prediction purposes
    (`CHALLENGER_PURPOSES`): `predict.primary`, `predict.baseline`, `select.bald`, `playground.predict` and
    `playground.baseline`.
  - Gates, trait reads and identity ranking stay on Jev, because their thresholds were tuned on Jev's probabilities.
    Widening the list is a code change.
  - Shadows, backfills and eval calls keep the model their predictor ID names.
- **Request adapter.** `planDecision` (`packages/core/src/decision-models.ts`) gives each model the request it takes,
  for any `decide` call, and hands the answers back keyed and typed as asked.
  - For span-01, the state is sent as its JSON text.
  - Each `choice` option and each `score` level becomes its own yes/no question ("would the person choose this
    option?"). The probabilities are normalized into a distribution (one-vs-rest): the expected level for a score,
    the top option for a choice.
  - Jev's requests pass through untouched, and the trace records exactly what was sent.
  - The one-vs-rest step is an approximation, so the benchmark reports quality per question type.
- **Fallback.** If span-01 fails, the same request goes to Jev. A failure is an HTTP error after the adapter's
  retries, a timeout, a malformed response, or a question left unanswered. Each attempt is its own `model_calls` row.
  A budget refusal is not retried.
- **Recording.** A prediction keeps its config's predictor ID. Its `modelSnapshot` names the model that answered, so
  reports split on it.
  - To make span-01 permanent, ship a new config (`cfg.default.v8`) with `jev:respan/span-01-20260925@jev-predict.v2`
    as primary, so predictor IDs say so, then retire the flag.
  - The primary's calibration (`jev-predict.v2`, temperature 4, fitted on Jev) applies to span-01's answers too.

## Flags

Flags live in the Cloudflare Flagship app **`mimic`** (`c4598f95-4f82-48c0-a8c5-62588cc2b598`). Both prod Workers bind
it as `FLAGS`; the ID is pinned in both `wrangler.jsonc` files. Preview and local dev bind none, so every flag reads
its code default there. A change in the dashboard applies within seconds, with no redeploy.

Every flag the code reads is defined once, in the registry `FLAG_SPECS` (`packages/core/src/flags.ts`). Each entry has
its key, type, code default, the var it overrides, and the values it accepts.

| Flag | Values | Code default | What it does |
| --- | --- | --- | --- |
| `decisions-model` | `jev`, `span-01`, or an OpenRouter Decisions model ID | `jev` | The model Jev's served predictions run on |
| `budget-usd` | A number above 0 | `BUDGET_USD`, else 1 | Spend cap per mimic (ADR-0035) |
| `search-provider` | `exa`, `perplexity`, `none` | `SEARCH_PROVIDER` | People search |
| `enrich-provider` | `exa`, `parallel`, `none` | `ENRICH_PROVIDER` | Enrichment |
| `embeddings-provider` | `workers-ai`, `openrouter` | `EMBEDDINGS_PROVIDER` | Embeddings (the same model either way) |

- **Accepted values.** Dashboard labels such as "Exa", "OpenRouter" or "Span-01" are accepted.
- **When a provider flag applies.** Only when its provider's key or binding is deployed; deploy pushes every provider
  key set in Doppler.
- **Values the code can't use.** They read as the default, with a log line.
- **Left as env vars:** `BUDGET_SESSION_SHARE`, `VECTOR_BACKEND` (it decides where the vectors are stored),
  `DEV_MODE`, `EGRESS_RELAY` and every secret.

### Checks that the flags are defined and readable

- **`pnpm flags:check`** (`scripts/deploy/flags.mjs` → `packages/db/src/flags-check.ts`) holds the app to the registry.
  - It **fails** when:
    - a flag is missing;
    - a variation, the default variation or a rule serves a value the code can't use;
    - a flag can't be evaluated through Flagship's evaluate API (the evaluation the Worker binding makes).
  - It **warns** about flags no code reads, and about flags that serve something other than their setting.
  - `--create-missing` creates a missing flag at its setting's value; this needs Flagship App · Edit.
  - It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, with Flagship App · Read and Evaluate on `mimic`.
- **Where it runs:**
  - The **Flags** workflow (`.github/workflows/flags.yml`), on every PR, every push to main and daily, since flags
    change without a commit.
  - Deploy preflight, which stops a deploy before it ships code that reads a broken flag.
- **Post-deploy:** `/api/health` evaluates every flag through the deployed Worker's own binding (`flagHealth`), and
  the smoke test fails if any errors (for example `FLAG_NOT_FOUND` or `TYPE_MISMATCH`).

### Enable span-01

1. Run the benchmark (below) and read its verdict.
2. In Flagship → `mimic` → `decisions-model` → Rules, add a rule that serves `span-01` to 10% (rollout on
   `targetingKey`, which is the mimic ID). Save.
3. Watch `model_calls` for model `respan/span-01-20260925`: its error rate and fallbacks (a failed span-01 row
   followed by a Jev row for the same job). Watch the primary's metrics in `/lab`, split by `modelSnapshot`.
4. Raise the rollout (10 → 50 → 100%), or set the default variation to `span-01`.

### Roll back

Set `decisions-model`'s default variation to `jev` and delete its rules. The next request runs on Jev, with no
deploy. Turning the flag off (Enabled → off) also works, because a disabled flag serves its default variation. If
Flagship itself fails, reads return the code default (`jev`).

## Run the benchmark

The benchmark runs the production primary and the same predictor on span-01 over the same sealed instances, with no
flag and no fallback, so each model's own numbers are measured.

For each model it reports, side by side:
- quality: log loss, accuracy, Brier and ECE, overall and per question type;
- latency per request (p50 and p95);
- cost per request;
- error rate.

It then prints the verdict of the decision rule.

**In CI (the usual way, after merge):** Actions → **Benchmark** → Run workflow.
- **Data:** the consented prod export, Twin-2K-500 people (public survey data from real people), or both.
- **Output:** the table and verdict land in the step summary, and `benchmark.md`, `.csv` and `.json` in the artifact.
  Per-question records stay on the runner.

**Locally:**

```
doppler run -- pnpm deploy:config --env prod
pnpm eval -- export --env prod --out data/bench.sqlite           # a fixed dataset: consented people only (ADR-0018)
pnpm eval -- benchmark --data data/bench.sqlite                  # live calls, capped at --max-usd (default $1)
pnpm eval -- benchmark --data data/bench.sqlite --incumbent jev:typesafe/jev-1.13   # raw scale too
```

- **Inputs.** Held-out people (`--split test`, never used to fit the calibration) at checkpoint `--k 30`. Up to 40
  targets per person, sampled with `--seed benchmark`.
- **Outputs.** Files go to `data/benchmark/<run>/`; `--summary <file>` also appends the Markdown there.
- **Reproducibility.** The report names the dataset hash, split, seed and both returned snapshots. The same file and
  seed select the same instances. Neither model takes a seed.
- **Cost.** A few hundred predictions cost a few cents. `--offline` runs the harness with fake providers for free (the
  numbers are meaningless).
- **Sample data.** `packages/eval/fixtures/twin2k500.sample.jsonl` is fictional: use it only to check the harness runs.

### Decision rule

Switch to span-01 only if it **beats Jev on quality** without an unacceptable regression. Every check must pass
(`DECISION_RULE`, `packages/eval/src/benchmark.ts`):

| Check | Passes when |
| --- | --- |
| Enough data | At least 200 paired predictions from at least 5 people |
| Better log loss | The paired bootstrap interval of log loss (span-01 − Jev) lies entirely below 0 |
| Accuracy held | Item accuracy is no more than 1 point lower |
| Error rate | At most 1 point above Jev's (each error is a fallback, so it costs both calls' latency) |
| Latency | p50 and p95 per request at most 1.5× Jev's |
| Cost | Per answered request, at most 1.5× Jev's |

Log loss is the headline metric because the stored predictions are probability distributions (PLAN §12). Failed
predictions count as uniform. A model that never answered fails the latency and cost checks.

### Harness check (2026-09-30)

A live run on the six fictional people of the bundled sample (`--split all --k 8`) cost $0.0008 in total. It proved
the harness end to end: both models answered all 30 predictions with no errors.

| | Jev | span-01 |
| --- | --- | --- |
| Latency p50 / p95 | 704 / 732 ms | 360 / 620 ms |
| Cost per request | $0.000059 | $0.000067 |

span-01 costs more per request despite its lower price, because each option becomes a question, about twice the
input tokens. These are not results: the people are fictional. The verdict was "keep Jev", on too little data.
