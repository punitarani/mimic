# Decisions

One short ADR per deviation from `docs/PLAN.md`. Newest last.

## ADR-0001 — Toolchain pins (2026-09-30)

- TypeScript `~5.9` rather than 7.x: TS 7 is the native compiler and Next.js's build-time type check still needs the JS API.
- Vitest `~4.1`: `@cloudflare/vitest-pool-workers@0.22` requires `vitest ^4.1`.
- `compatibility_date = 2026-08-15`: the workerd bundled with the Vitest pool supports dates up to 2026-08-22.
- Biome (not ESLint) for lint and format.

## ADR-0002 — Local egress relay for `pnpm dev` (2026-09-30)

In the Claude Code remote environment, provider keys are injected by an outbound proxy that only Node's proxy-aware
fetch uses. workerd (`wrangler dev`) reaches the network without that proxy, so provider calls fail with 401.
Adapters therefore accept an `EGRESS_RELAY` base URL: `https://host/path` is requested as `{relay}/host/path`, and
`scripts/egress-relay.mjs` (bound to 127.0.0.1, allowlisted provider hosts only) forwards it with
`NODE_USE_ENV_PROXY=1`. Auth headers are only sent when a key is configured. Deployed envs leave `EGRESS_RELAY` unset.

## ADR-0003 — SQL vector index in local dev and the CLI (2026-09-30)

Vectorize has no local mode. `VectorIndex` has two implementations: `VectorizeVectors` (deployed, `VECTOR_BACKEND=vectorize`)
and `SqlVectors` (a `vectors` table with brute-force cosine; per-mimic data is small). Vector IDs are deterministic
(`{mimicId}:qa:{seq}`, `{mimicId}:fact:{factId}`, `{mimicId}:q:{questionId}`) so hard delete can remove them without
listing. The index additionally stores question-prompt vectors (kind `question`) for pool dedupe and redundancy.

## ADR-0004 — DeepSeek V4.1 Flash as the default generator and reflector (2026-09-30)

Per the project owner, `cfg.default.v1` uses `deepseek/deepseek-v4.1-flash` for the generator and reflector (PLAN §7.1
says GPT-6 Luna). Luna and GLM 5.3 Flash remain shadows and E5 arms. OpenRouter routing prefers Wafer
(`provider.order = ['wafer']`, fallbacks allowed): in a live check, an unpinned request was routed to a provider that
ignored `json_schema`, while Wafer honored it at ~1/10 of the cost.

## ADR-0005 — Embeddings: `baai/bge-base-en-v1.5` (2026-09-30)

PLAN §5 asks to pick the Workers AI embedding model at M1. The same model is served by Workers AI (`@cf/baai/bge-base-en-v1.5`,
768-d) and OpenRouter. Deployed envs use Workers AI; local dev and the Node CLI use OpenRouter, because the Workers AI
binding needs a Cloudflare account even in `wrangler dev`. `PipelineConfig` gains `embedding: { model }` since the
model drives dedupe and retrieval. Workers AI returns no per-call cost, so those calls log `cost_usd = 0`.

## ADR-0006 — Static reserve bank (2026-09-30)

`reserve.v1` holds 20 hand-written adaptive items. `/next` serves from it only when the generated pool is empty, so a
session never stalls on an LLM. They are normal `adaptive` questions with generator `reserve.v1` and an `item_key`.

## ADR-0007 — Identity sub-state (2026-09-30)

`mimics.identity_state` (`skipped | searching | candidates | none_found | enriching | review | done`) tracks identity
resolution so the UI can show progress. `mimics.status` still follows PLAN §8.

## ADR-0008 — Per-mimic occupation facets table (2026-09-30)

Occupation facets (PLAN §9.8 step 4) are stored in `mimic_facets` (mimic_id, facet_id, json). Their IDs are
prefixed `occ_`.

## ADR-0009 — Parallel enrichment cost and availability (2026-09-30)

The Parallel Task API is priced per processor and returns no per-run cost, so `identity.enrich` logs `cost_usd = 0`.
`api.parallel.ai` is blocked by this environment's egress policy, so the adapter was built from the published
OpenAPI spec with a documented fixture; its live smoke test skips when the host is unreachable. Enrichment is
best-effort: on failure the person still reviews the facts from the confirmed candidate.

## ADR-0010 — Sealed states are stored (2026-09-30)

At serve time, the sealed state and the context-only state are written to R2 at `states/{mimicId}/{stateHash}.json`.
`predict.shadow` loads that blob and verifies its hash, so primary and shadows share a byte-identical state even
though derived traits keep changing. It also makes each prediction reproducible from its state hash.

## ADR-0011 — Schema additions (2026-09-30)

- `questions.item_key`: stable IDs for cross-person items (anchors, reserve bank).
- `questions (mimic_id, seq)` unique: two concurrent serves can't take the same seq.
- `predictions.prompt_version` (invariant 4) and `predictions.fallback` (PLAN §16 LLM fallback when Jev errors).
- `scores.mimic_id`: per-mimic queries and hard delete without joins.
- `trait_estimates.model_snapshot`.
- `vectors` table (ADR-0003) and `mimic_facets` (ADR-0008).

## ADR-0012 — Playground and repeat evidence never enter states (2026-09-30)

Playground answers (PLAN §9.11) are a separate user-verified test set, so the state builder excludes them, like
repeats. Repeat probes are shown to the client as `adaptive` so the person can't tell a probe from a new question.

## ADR-0013 — Trait reads use the raw state (2026-09-30)

`learn.answer` reads traits from identity + evidence (strategy `raw`), so a read never anchors on the previous read's
output.

## ADR-0014 — Local dev shares one state directory across two processes (2026-09-30)

`next dev` (bindings via wrangler's getPlatformProxy) and `wrangler dev` (the worker) share `.wrangler/state`, so the
web app enqueues jobs that the worker consumes, exactly as in deployed envs. Two consequences:

- OpenNext's lazy context fallback calls getPlatformProxy without options (persisting to `apps/web/.wrangler`), so
  `apps/web/lib/server.ts` initializes the dev context itself with the shared persist path, once per process.
- Two processes writing the same SQLite files occasionally hit `SQLITE_BUSY` (surfacing through the proxy as an opaque
  `internal error`). With `DEV_MODE=1` (both `.dev.vars`), D1, R2 and KV calls retry on those errors with backoff.
  Deployed envs only retry D1 on explicit `SQLITE_BUSY`, which a failed statement or batch never partially applies.

## ADR-0015 — Quality-gate thresholds tuned on a labeled set (2026-09-30)

In the first live session, the `ambiguous` gate worded as in PLAN B.3 scored nearly every generated candidate between
0.70 and 0.88, so the plan's 0.6 threshold rejected 180 of 181 candidates and the pool never filled (the reserve bank
kept the session going). PLAN §9.4 asks to tune the thresholds on a small labeled set, so
`packages/eval/data/gates.labeled.v1.json` (32 hand-labeled items) and `pnpm eval -- gates` were added. Results with
`typesafe/jev-1.13-20260917`:

| Gate | AUC | Chosen threshold |
| --- | --- | --- |
| ambiguous | 0.81 | fail if p(yes) > 0.85 |
| sensitive | 1.00 | fail if p(yes) > 0.40 (stricter than 0.6 on purpose) |
| leading | 1.00 | fail if p(yes) > 0.55 |
| quick | 0.99 | fail if p(yes) < 0.60 |

The thresholds are versioned as `gates.v2` and stored in each question's `quality_json`. Re-run the calibration when Jev's
snapshot changes. The set is small; grow it before drawing conclusions about generator quality.

## ADR-0016 — Deferred work after the response on the synchronous path (2026-09-30)

`EngineDeps.defer` runs work that may finish after the HTTP response (Next's `after()`, i.e. `waitUntil` on Workers):
writing the sealed-state blobs and then enqueueing the shadow jobs that read them, pool refills, and the
`learn.answer` enqueue. The primary and baseline predictions are still persisted before `/next` returns
(PLAN §3.2). Question-prompt vectors for the redundancy term are cached per isolate. Both routes emit per-phase
`Server-Timing` headers.

## ADR-0017 — Sealed states pin their derived data to a recorded time (2026-09-30)

PLAN §3 requires every prediction to be reproducible from its config hash, prompt version, model snapshot and state
hash, and M7 requires replaying an export to reproduce the online primary scores. Evidence is sealed by seq, but a
state also carries derived data (trait estimates, insights, identity facts) that background jobs write at any time.
The first live reproduction rebuilt only 22 of 28 states: `learn.answer` traits landed 0.4–4.5 s before `servedAt`,
after `/next` had loaded its data, so a rebuild "as of servedAt" saw traits the served state never had.

- `/next` (and the playground) take `stateAt = now − STATE_SETTLE_MS` (2 s) before loading, and build sealed states
  from `loadMimicDataAt(m, stateAt, seq)`, the same loader replay uses. `stateAt` is stored on the question
  (`questions.state_at`, migration 0002). The 2 s lag means a write in flight while a question is served lands
  clearly on one side of `stateAt`. Derived data younger than that waits for the next question; evidence is never
  time-filtered.
- As-of rules: trait estimates come from the append-only `trait_history` (latest `seqUpTo` below the question's seq
  among rows written by `stateAt`, first write winning ties, which is the monotonic upsert's rule). Insights count if
  created by then and not superseded before then (`insights.status_changed_at`, migration 0001). Facts count if
  created by then and not removed. Removal is never time-travelled: a fact removed now, or toggled after `stateAt`,
  stays out, so a state served before a removal no longer rebuilds byte for byte. Privacy wins over replay
  (PLAN §3.8). `facts.user_state_at` records the last toggle.
- Checkpoint replay uses the same loader, as of the `stateAt` of the question at the checkpoint. Before, it used the
  current trait rows, whose `seqUpTo` is the latest, so early checkpoints silently lost their traits.
- Two kinds of state are reported but not hash-checked by `replay --mode online`:
  - Legacy: served before `state_at` existed; rebuilt as of `servedAt`, approximately.
  - Truncated: over the evidence budget, where retrieval ranked evidence against the candidate pool with
    embeddings. Neither is in the export, so only the sealed state blob in R2 (keyed by the state hash) reproduces
    these exactly.
- Tests: the reproduction test injects a trait write between `stateAt` and the read. It fails without pinning (95.7%
  hash match) and passes with it (100%).

## ADR-0018 — Eval exports, the identity-keeping export and the Twin-2K-500 importer (2026-09-30)

- `export --env local` copies rows straight from the shared miniflare SQLite file, since `wrangler d1 export` has no
  `--persist-to`. Remote environments use `wrangler d1 export --remote --no-schema`. Both then apply the same scrub
  (`scrubExport`):
  - Only research-consented mimics are kept; jobs and vectors are dropped.
  - Names, locations, links, URLs, trace and snapshot keys, and idempotency keys are removed.
  - Mimic and participant IDs become salted hashes.
- `--keep-identity` skips the identity scrub (consent filtering still applies). It exists only for the internal
  reproducibility check: sealed states include the name and location, so their hashes can only be rebuilt from an
  unscrubbed copy. The CLI warns that such a file must never be shared.
- The dataset hash covers the content of every data table except `eval_runs` and migration bookkeeping, row order
  ignored. Eval commands record their runs in the data file, and a file hash changed after each run.
- Twin-2K-500 (`import twin2k500`) reads JSON Lines converted from the Hugging Face `wave_split` config. Only items
  that map onto typed primitives are imported:
  - single-choice MC with 2–5 options (yes/no → `noul`);
  - Matrix rows with 2–5 columns (5 ordered columns → `score`).
  Waves 1–3 become evidence, wave 4 becomes held-out items (`twin2k/w4/…`, never in a state), and wave 1–3 answers
  to wave 4 questions become repeat pairs for test-retest self-consistency. Hugging Face is not reachable from this
  environment, so the importer is tested on a synthetic six-person fixture in the dataset's shape
  (`packages/eval/fixtures/twin2k500.sample.jsonl`).
- `select` simulates selection within each person's already-answered pool. It is biased, since the pool was itself
  selected online; its reports say so. Use it for iteration only.

## ADR-0019 — The worker's cron runs in local dev and repairs missing shadows (2026-09-30)

`wrangler dev` never fires cron triggers, so the stale-job requeue from M5 never ran locally. `pnpm dev` now starts
the worker with `--test-scheduled` and calls `/__scheduled` 30 s after start and every 10 minutes after that. The
cron also calls `enqueueMissingShadows` for mimics active in the last 24 h. This covers shadows whose enqueue was
lost outright, so no ledger row exists to requeue. Examples are a failed `after()` and data served before shadows
existed. Each such shadow is enqueued for questions served more than 10 minutes ago. Shadows read the sealed state
blob, so a late shadow is still sealed (PLAN §3.1), and job keys make repeats no-ops. On local dev data the first
run requeued 12 stale jobs and enqueued 51 missing shadows; the lab's invariant monitor went from 25 incomplete
questions to 0.

## ADR-0020 — Experiments, the arms UI and BALD attribution (2026-09-30)

- `/lab` registers configs (derived from an existing one in a JSON editor, validated by the `PipelineConfig` schema,
  identified by hash) and builds experiments: two or more uniquely named arms, each a config with a weight.
  Starting an experiment stops the active one. Arms are fixed once an experiment exists (the API returns 409),
  because allocation is `hash(mimicId)` over the arms. Changing them would silently re-assign future mimics
  mid-experiment; only the status can change.
- Arm curves are scoped to one experiment: the active one by default, any experiment via `?exp=`, or every mimic
  grouped by arm via `exp=all`. Each arm reports mean final fidelity and E3's primary metrics (PLAN §12.7):
  - fidelity at 20 questions;
  - the median number of questions after which fidelity is ≥ 0.75 and stays there through the last answer, with
    how many mimics got there. Fidelity after one or two answers is noise; a "first crossing" definition reported
    1 question for an arm whose fidelity then fell to 44%.
- BALD's K hypothesis calls use the same Jev model as the primary but are logged as `select.bald`, so cost per call
  type separates exploration from the sealed primary (still one `predict.primary` per question).
- Snapshot blobs are keyed per write attempt (`v{n}-{id}.json`). Live, two `snapshot.write` jobs raced for the same
  version: the loser's R2 put had already overwritten the winner's committed blob before its D1 insert failed. Now
  the loser deletes its own blob and retries.
- Stale jobs are requeued after 15 minutes (was 30), the Workers limit for one consumer invocation.

## ADR-0021 — Session UI v2 from the Claude Design handoff (2026-09-30)

The session page and model panel now follow `Mimic Session v2` (Claude Design handoff: 7 desktop frames, 5 panel
frames, 4 mobile frames and their components). The backend flow is unchanged. Only these additive,
backward-compatible fields were added, all agreed before implementation:

- `Reveal.dist` on `POST /answers`: the sealed primary distribution over every option. It is shown only after the
  answer, for the per-option bars and the scale's distribution with its expected tick.
- `AnswerInput.revealShown` (optional; default shown), from the menu's "Show guesses after each answer". When
  false, the server neither returns the reveal nor records `revealedPrediction`. The toggle can't mislabel research
  data, and it is hidden for configs whose reveal is `never`, which stays an experiment variable (PLAN §12.2).
- On the snapshot:
  - `history[].{ciLow, ciHigh, selfConsistency}` for the chart's band and "profile alone" line;
  - `progress.basics`, the anchor count, for "Learning the basics";
  - `facets[].labels` for readings such as "leans toward the familiar".

Behaviour choices:

- **Answering and advancing:** picking an option answers it (click, 1–5, Y/N or 1–2). The reveal appears in a
  fixed-height action area, and Next or Enter advances; there is no auto-advance. A scale reserves its reveal bars'
  height below the action area, so the prompt and options never move. A browser test measured this: 0 px movement
  over 13 desktop and 15 mobile answers.
- **Reasons:** a reason goes in before answering, in the action area, and is sent with the answer. After the
  reveal the button is disabled with a note, because a reason written after seeing the guess would be biased.
- **Lift:** "N points better than a guess from your profile alone" is on the fidelity scale (fidelity minus
  baseline accuracy ÷ self-consistency), so it matches the chart's "profile alone" line.
- **What changed:** computed in the page from the snapshot before the answer and fresher ones after it (score,
  facets that moved or became more certain, a new insight). The snapshot is re-read at 0, 2.5, 6 and 12 s while
  learning jobs land. After a reload only the score row is available, from the history.
- **Theme:** Light, Dark and System, stored on the device. It is applied before paint and uses the design's dark
  palette. Existing Tailwind colour names alias the new tokens, so every page follows the theme.
- **Fonts:** Hanken Grotesk and Newsreader, loaded from Google Fonts as in the design.
- **Knowledge graph:** Session v2's panel has no knowledge-graph map, so the map moved to `/m/[id]/mimic`.
- **Evidence chips:** the design's chip popover also shows "Mimic guessed". The snapshot doesn't carry the
  mimic's guess per evidence item, so the popover shows the question and the person's answer only.

## ADR-0022 — Continuous deployment to Cloudflare from Doppler-synced GitHub secrets (2026-09-30)

Prod deploys itself. CI (`.github/workflows/ci.yml`) runs lint, typecheck, test and a deploy dry run in parallel on
every PR and push. When it completes green on a push to `main`, `.github/workflows/cd.yml` checks out the commit CI
tested and runs `pnpm deploy:prod`. The steps are in `docs/DEPLOY.md`. `scripts/provision.sh`, the per-app deploy
scripts and `db:migrate:{preview,prod}` are gone.

- **Doppler is the source of truth.** Its GitHub integration syncs project `mimic`, config `prd`, to repository
  secrets, and CD passes them to the one deploy step. Locally, `doppler run --` supplies the same names.
- **Secrets go up with each deploy** (`wrangler deploy --secrets-file`), so Doppler and the Workers can't drift, and a
  first deploy works. `wrangler secret bulk` would need the Worker to exist already, and wrangler refuses to create a
  Worker whose `secrets.required` are unset.
- **Settings are deploy-time.** `SEARCH_PROVIDER`, `ENRICH_PROVIDER`, `EMBEDDINGS_PROVIDER` and `VECTOR_BACKEND`
  default to the `vars` in `wrangler.jsonc`. A value in the deploy environment overrides them. Each provider's key is
  required only when that provider is chosen, so the worker's `secrets.required` is just `OPENROUTER_API_KEY`.
  Fixtures and the hash embedder are refused.
- **Resources are found or created by name** through the Cloudflare API on every deploy. Wrangler's
  auto-provisioning is not used: it gives each Worker its own KV namespace and never creates queues or Vectorize
  indexes. Real IDs and settings go into a gitignored `wrangler.deploy.jsonc`; the checked-in configs keep
  `REPLACE_ME_*`. The eval CLI's remote commands use the same generated file (`pnpm deploy:config`).
- **The lab is behind Cloudflare Access in prod.** The deploy creates the Access app and policy. The web Worker is
  reachable only on `mimic.punitarani.com`, because `workers_dev` and `preview_urls` are off. Preview is on
  `workers.dev` with no Access in front, so it gets no `ADMIN_EMAILS` and its lab is closed.
- **Gates:**
  - CI must be green on the exact commit.
  - Only pushes to this repository's `main` deploy; a fork PR's run never gets secrets.
  - Preflight fails fast, naming anything missing.
  - Migrations run before code.
  - A smoke test checks the landing page, `/api/health` and the Access redirect on `/lab`.
  - Deploys are serialised and never cancelled mid-flight.
- **Only prod is deployed continuously.** Preview is deployed by hand from any Doppler config.

## ADR-0023 — Workers observability and caching (2026-09-30)

- **Traces and logs.** Both Workers persist logs (with invocation logs) and automatic traces, at a head sampling
  rate of 1. That is the top-level `observability` block in each `wrangler.jsonc`, which preview and prod inherit.
  - A trace has spans for each request, queue batch and cron run, and each D1, KV, R2, queue and outbound fetch call
    inside it.
  - Headers and bodies aren't recorded, so provider keys never reach it.
  - The app's own model and search traces stay in `model_calls` and R2 (invariant 5).
  - View them in the dashboard under Workers → Observability. Lower the rate if traffic grows.
- **Page caching.** Nearly every page is per-person and `force-dynamic`, and those keep
  `private, no-store`. The few prerendered pages (`/new`, the icon) use OpenNext's static-assets incremental
  cache with cache interception, so they are served from the Worker's assets without loading the Next server
  (`x-opennext-cache: HIT`). Nothing uses ISR or `revalidateTag`, so there is no R2/KV incremental cache, tag cache
  or revalidation queue.
- **Static assets.** `apps/web/public/_headers` marks the content-hashed `/_next/static/*` as
  `public, max-age=31536000, immutable`. The Workers default is `max-age=0, must-revalidate`, which cost a
  revalidation request per file on each load.
- **App data** keeps its existing caches:
  - configs by hash in each isolate;
  - question vectors;
  - identity search results in KV with a TTL;
  - BALD hypotheses in KV.

  Nothing on the prediction path is cached across requests, because sealed states must be built from the database
  (invariant 1). A process-wide "config already stored" memo was considered and rejected. Deps are built per request,
  and in tests and the eval CLI one process talks to several databases, so the memo would skip real inserts.

## ADR-0024 — MiMo V2.6 Pro shadow, and backfilling new predictors (2026-09-30)

**MiMo V2.6 Pro shadow.** `llm:xiaomi/mimo-v2.6-pro` is now the fourth shadow. It runs through the same `predict.v1`
JSON-schema prompt as the other LLM shadows. A live check returned a schema-valid distribution at about $0.0001–0.0007
per prediction and 6–24 s. OpenRouter routed it to GMICloud or DeepInfra; the provider is part of `modelSnapshot`.

Configs are immutable, so this is a new default, `cfg.default.v2`, which is `cfg.default.v1` plus the shadow. Both
hashes are pinned in a test. Mimics created before v2 keep v1, and new mimics get v2, where the cron's
missing-shadow repair covers MiMo too.

**Backfill.** When a predictor is added, `pnpm backfill --predictor <id> [--env local|preview|prod] [--consented]
[--mimic <id>]... [--yes]` gives it the questions served before it existed.

- **Dry run by default.** The script:
  - checks that the model exists on OpenRouter with structured outputs;
  - counts the missing predictions per mimic;
  - estimates cost from what this predictor has cost so far (never from a price table).
- **`--yes`** publishes one job: through the Queues HTTP API in deployed envs, or through the `pnpm dev` worker's
  `POST /__jobs` locally. That route exists only with `DEV_MODE=1`, and deployed workers serve no URL anyway.
- **Two new job types:**
  - `backfill.predictor` enqueues one `backfill.mimic` per mimic, optionally consented only.
  - `backfill.mimic` enqueues `predict.shadow` for each served anchor or adaptive question that has a primary and no
    prediction from that predictor, in any role. `enqueueMissingShadows` now uses the same rule, and the script's dry
    run counts exactly those questions.
- **Same path as a live shadow.** Each prediction reads the primary's sealed state blob, so it stays sealed (PLAN
  §3.1). It is logged through the gateway (invariant 5), stored with the mimic's `configHash`, its own `predictorId`,
  prompt version and model snapshot (invariant 4), and scored against the answer if there is one.
- **Idempotent and safe to repeat.** Job keys and the existing-prediction check dedupe the work. A later run
  (a new `runId`) enqueues only what is still missing, so re-running the dry run shows progress.

Checked on local dev data: one mimic's 9 missing MiMo predictions ran through the real worker for $0.0043 in total.
All 9 used the primary's sealed state, and 8 were scored; the ninth question was served but never answered. A
re-run reported 0 missing.

## ADR-0025 — Flash-tier shadows: MiMo V2.6 Flash and Qwen3.8 Flash replace MiMo V2.6 Pro (2026-09-30)

After the prod backfill, the lab showed MiMo V2.6 Pro essentially tied with GLM 5.3 Flash:

| Model | Accuracy | Lift | Log loss | ECE | $ per 1k predictions | p50 latency |
| --- | --- | --- | --- | --- | --- | --- |
| MiMo V2.6 Pro | 62.3% | +6.4 | 1.088 | 0.053 | $1.57 | 12.0 s |
| GLM 5.3 Flash | 62.2% | +6.3 | 1.091 | 0.117 | $0.60 | 1.5 s |

That was on n = 147 and 152 questions, where the gap is noise. MiMo Pro cost 2.6× as much and was 8× slower. It did
have the best calibration (ECE 0.053), so it stays in the record.

`cfg.default.v3` keeps the v1 shadows and replaces MiMo V2.6 Pro with two Flash-tier models:

- `xiaomi/mimo-v2.6-flash`, at $0.14 and $0.28 per million input and output tokens;
- `qwen/qwen3.8-flash`, at $0.15 and $0.47.

Both support structured outputs, and each returned a valid `predict.v1` distribution in a live call. The live test
covers every shadow in the default config.

Configs are immutable, so mimics created under v2 keep MiMo Pro and its predictions stay. New mimics get v3. The two
new shadows reach questions served earlier through `pnpm backfill`, which now takes several predictors: repeated
`--predictor` flags, or a comma-separated list, which is also what the Actions workflow takes. Every model is checked
before anything is enqueued, and each predictor gets its own job.

## ADR-0026 — Invite links (2026-09-30)

An invite can be shared as a link instead of a code to type: `/new?invite=CODE`, or `/?invite=CODE`, where the
landing page's button carries it to `/new`.

- **The field is filled in and disabled.** The person sees the code and a hint that it came from the link, but
  can't edit it. Any failed submit (an invalid code is a 403 on `POST /api/mimics`, but also a 400 or a 429)
  unlocks the field and focuses it, so a stale link is recoverable without leaving the page.
- **Still checked server-side only.** The link changes nothing about `INVITE_CODES` or the route handler. The
  query value is trimmed and otherwise passed through as typed input would be.
- **Codes in links are low-secrecy.** A code in a URL lands in browser history, the same-origin Referer and the
  Workers invocation logs (ADR-0023 records URLs, not bodies). `INVITE_CODES` gates a private cohort, not data,
  and is rotated by a deploy; treat a link as shareable as the code itself.
- **`/new` stays prerendered** (ADR-0023). Reading the query string happens in a client component under a
  Suspense boundary whose fallback is the same form with no code, so the static HTML is what it was before, and
  hydration only fills the field in.
- Disabled inputs now share one look (`components/ui.tsx`): surface background, muted text, no hover border.

## ADR-0027 — Value-of-information selection, belief-driven generation and cross-person item statistics (2026-09-30)

The adaptive loop asked what the predictor was unsure about. That over-selects noisy questions, ignores what the
person's own answers contradict, ignores where the mimic is actually wrong, and learns nothing from other people.
`docs/SELECTION.md` sets out the replacement and the research behind it (adaptive testing, expected information
gain, BALD, the digital-twin mega-study, response-time evidence, survey satisficing, hierarchical priors). This
ADR records the decisions.

- **Belief state** (`packages/core/src/belief.ts`): per facet, uncertainty (trait-read entropy and confidence),
  conflict (Jev vs psychometric reads, superseded insights, repeat flips, torn answers), weakness (the sealed
  primary's recent error on the facet, shrunk toward the person's overall error), coverage and exposure; per
  domain, share and weakness; per person, median latency, speeding and straightlining. Pure and deterministic;
  never in a prompt or a state.
- **`voi` selector** (`selector.type = 'voi'`): `info + λ·gap + β·conflict + γ·weakness + π·(pop − ½) − μ·redundancy
  − ν·burden`, with exposure control (a facet may take at most 35% of the adaptive questions once 4 are answered).
  `info` is on one scale per selection: posterior-weighted hypothesis mutual information when any candidate has
  ≥ 2 hypothesis predictions (0 for a candidate whose exploration calls failed), else predictive entropy for every
  candidate. Exposure control is shared with the generator (`overExposed`) and starts after 4 adaptive answers.
  The chosen question's sealed primary is still the plain-state prediction from the batched call. The winning
  score's components go to `questions.selection_json`.
- **Persona posterior.** The chosen question's per-hypothesis predictions are stored as `role = hypothesis` rows
  tagged `{set seqUpTo}:{index}` (`predictions.hypothesis`), with their states in R2 like every other prediction
  (ADR-0010). They are never scored. On each serve the weights are recomputed from those rows and the answers
  given since the set was written (uniform prior, likelihoods floored at 1e-4). `hypotheses.refresh` now runs
  for `voi` as well as `bald`. Backfill and the missing-shadow repair ignore hypothesis rows.
- **`gen.v2`**: targets are the five facets with the highest need, each with why (unexplored, uncertain,
  conflicted, weak) and the person's current reading, so the generator pitches trade-offs at that reading (the
  adaptive-testing rule that an item is most informative where its difficulty matches the estimate). Facets over
  the exposure cap are listed to avoid; the domain quota is tilted toward the weakest domains. Pooled candidates
  count toward coverage so a refill does not pile onto facets the pool already has.
- **Latency hints** (`stateBuilder.latencyHints`, builder `full.v2`): evidence carries `pace: quick | slow` for
  answers under half or over twice the person's median latency over the sealed evidence, costed against the
  budget as rendered. A latency of 0 means "not recorded" everywhere (no pace, never speeding). Deterministic
  from exported data (`answers.latency_ms`), so replay still reproduces states. Optional and undefaulted in the schema,
  so configs written before it keep their hashes (v3 is pinned in a test next to v4).
- **Item statistics** (`item_stats`, migration 0003, `stats.refresh` from the cron hourly): aggregate rows per
  `item_key` and per `facet | domain | type` archetype over research-consented dev-split mimics, read in one join
  query and written by replacing the whole table atomically, so a deleted mimic or a withdrawn consent drops out
  at the next run and no stale key survives. Groups with fewer than 5 people are never written, so no stored row
  is one person's numbers. `pop(q)` is `½·answer entropy + ½·baseline error` for items, or the mean over the
  question's facets' archetypes of `½·surprise + ½·baseline error`, shrunk toward ½ with a prior of 20 answers.
  It ranks candidates only, never enters a prompt or a state (PLAN §3.8), and its weight π is bounded. The test
  split never feeds it. `/next` reads the table through a per-isolate cache with a 5-minute TTL.
- **Guardrails against getting worse with use**: every term is bounded; coverage, uncertainty and conflict decay
  on their own; the exposure cap stops a noisy facet from monopolising a session; weakness is prequential; burden
  grows with session length; population statistics are a shrunk, bounded prior that cannot override the person's
  own terms and are reported as a separate ablation (`pnpm eval -- select --selector entropy,voi` and
  `--no-population`).
- **Default config `cfg.default.v4`** = v3 + `voi`, `gen.v2` and latency hints. Mimics created under v1–v3 keep
  their configs. Not done: one-step lookahead EIG on the pool (exact but |pool| × |options| Jev calls), a shared
  bank of generated questions (needs a leakage check), Twin-2K-500 item statistics as a cold-start prior.

## ADR-0028 — Prediction prompt variants, the eval loop and GEPA-style optimization (2026-09-30)

`docs/OPTIMIZATION.md` is the design; this records what was built and the choices made.

**Prompt components and variants.** The prediction prompts are named text components
(`packages/core/src/components.ts`): the LLM predictor's system prompt and user template, the evidence line of the state
text, and Jev's instructions and criteria templates. The incumbents render byte for byte what the old literals did
(pinned by a test). A registered variant is addressable as `llm:<model>@<version>` or `jev:<model>@<version>`
(`parsePredictorId`), so it can be a config's primary or shadow, and `pnpm backfill` can run it over served questions
on the primary's sealed states. `predictions.prompt_version` now comes from the predictor ID instead of a literal.
Without a suffix nothing changes: the IDs, prompts and config hashes of v1–v3 are untouched. Variants are mirrored to
`docs/prompts/variants/`. A variant may also set harness options: reasoning effort, max tokens, an output schema with
a short rationale before the probabilities, and Jev receiving the state as the LLMs' text rendering.

**Evaluator.** `mimic-eval evaluate` scores candidates on sealed instances: each served question with its state rebuilt
as served (ADR-0017), or, for Twin-2K-500 people, their first k answers against the held-out wave. Each record carries
log loss, item accuracy, Brier, the stored baseline's accuracy on the same question, and textual feedback (the answer,
the person's reason, the profile-only guess, related earlier answers, repeat agreement). `--from stored` reports on the
predictions already stored, with no model calls, and fits a temperature per predictor, shrinkage toward the baseline
and Jev + LLM log-linear pools on dev people, checked on test people.

**Optimizer.** `mimic-eval optimize` is a TypeScript GEPA loop over the real engine code (no Python, no second copy of
the prompts): Pareto parent sampling over per-instance validation scores, one component rewritten per iteration by a
reflection model reading a minibatch of cases, acceptance only when the child beats its parent on the minibatch by
more than the measured noise floor, then a full validation pass. Choices:

- *Objective:* −log loss per question, so calibration counts; a failed output scores as a uniform guess minus 1 nat.
- *Splits:* dev people train and validate (by person with 6 or more dev people, otherwise by question); test people
  are a holdout evaluated once, after selection (PLAN §12.4). "Improved" needs the validation gain above twice the
  noise standard error, a 90% bootstrap CI above zero, and no loss on the holdout beyond that margin.
- *Leakage lint:* a child is rejected if it adds a 6-word sequence from any question, reason or insight in the data, or
  an identity detail (name, location, employer, fact). Instruction-only optimization with no real-person demos keeps
  invariant 8.
- *Reflection model:* `anthropic/claude-sonnet-5.5` by default ($2/$10 per million tokens at the time), low reasoning
  effort. It is offline tooling, logged through the gateway as `eval.reflect`, never in a production config.
- *Budgets:* hard caps on predictions (`--max-metric-calls`, default 400) and dollars (`--max-usd`, default 2); an
  iteration that could not be validated within either is not started. Runs are resumable from `--run-dir`.
- *Cost:* Jev components are the default target because Jev bills input only (about $0.0001 per question), so a run
  is dominated by reflection calls.
- *One person per reflection:* each minibatch is drawn from one person, and `diagnose` makes one call per person, so
  no prompt mixes people's answers (invariant 8). Names are left out of the cases as well. These are offline analysis
  calls on consented, scrubbed data, and their output passes the leakage lint before it can reach a product prompt.
- *Tooling prompts are versioned:* the reflection and diagnosis prompts (`optimize.reflect.v1`,
  `optimize.diagnose.v1`) live in `packages/eval/src/optimize/reflect.ts`, are recorded on each run and mirrored to
  `docs/prompts/optimize/` with a sync test. A reply that breaks a rule gets one repair turn naming the problems.
- *Transport failures are not scores:* predictors label a failure `transport` or `output`. Only the failed questions
  are retried once. A transport failure is never cached. If it persists, the optimizer stops gracefully rather than
  let an outage decide an acceptance, the Pareto front or the holdout; the run can be resumed. A malformed output is
  the candidate's fault and is scored as a failure.
- *Batching and margins:* Jev questions that share a state go in one request, split only near the 32K context. The
  minibatch margin uses the size of the minibatch actually drawn. With six or more dev people, a balanced, seeded
  half of them validate. A run directory refuses to resume against different data, since exports re-salt IDs.
- *Validation at the edges:* `PipelineConfig` rejects an unregistered or incumbent-aliased `@<version>`, so `/lab`
  can't register a config that would break `/next`. `pnpm backfill` checks a version against
  `docs/prompts/variants/` before enqueueing. Published metrics are compacted to fit one D1 statement; the full report
  is in R2.

**Shipping.** A winner is never deployed by the optimizer. It writes the candidate and a `PREDICT_PROMPTS` entry to
paste; registering it is a code change reviewed like any other, then `pnpm backfill --predictor <id>@<version>` gives a
within-person comparison on identical sealed states in `/lab`, and promotion to primary goes through a config and an
experiment arm. Calibration post-processing is reported but not applied online yet (a later config field).

**Where it runs.** `.github/workflows/optimize.yml` (Actions → Optimize), like the backfill: export prod (consented,
scrubbed), optionally add Twin-2K-500 people, report on stored predictions for free, and optionally optimize. Only
aggregates and prompt text leave the runner: the step summary, `/lab`, and an artifact with the candidate. Hugging
Face is blocked in the Claude Code environment, so the Twin step runs only in Actions and is best-effort there.

## ADR-0029 — Identity search: plain queries, the person's link, a name filter and search again (2026-09-30)

Two real people tried identity search in prod and neither was offered: a software engineer with a rare name got two
strangers, and a recent graduate with a common name got nothing. Replaying their intakes against Exa found the causes.

- **Quoted names.** Every query was `"{name}" …`, as PLAN §9.2 suggested. Exa's people index is semantic and has no
  phrase operator: the quoted query returned strangers (both engineers, neither named like the person) or zero
  results. Unquoted, the engineer is Exa's first result for every variant tried. Queries are now plain descriptions
  that lead with the name: `{name}, {occupation} at {employer}, {location}`, the same without the location, and the
  name alone. The graduate's profile shows up when the query includes her school or field; the name alone is buried
  under namesakes.
- **The link was never used.** Intake says a link "makes finding you much more accurate", but search ignored it. Now
  the link is read with Exa `/contents` (a LinkedIn URL resolves to the same person entity as search; any other page
  gives its title and text) and that profile is always kept and listed first. It's logged as `identity.lookup`.
- **A merge that favoured the first query.** Results were concatenated in query order and cut to 8 before Jev saw
  them. They're now merged by reciprocal rank, deduped by profile URL and cut to 10, the most the screen lists.
  `profileKey` (`@mimic/core/links`, shared with the browser) ignores the scheme, `www.`, a trailing slash and
  tracking parameters, and treats every LinkedIn host (country and mobile) as one with case-insensitive paths.
  Other query parameters count (`profile.php?id=…`).
- **No name check.** Strangers were offered. A profile with no name part in common with the intake is dropped,
  ignoring accents, apostrophes (O'Brien = OBrien), other punctuation and suffixes (Jr., PhD). A last initial that
  ends the name counts, since LinkedIn shows "First L." outside someone's network, which is exactly how the
  graduate's profile appears; a middle initial doesn't.
- **Blank fields.** Intake stored a blank occupation as `''`, and `??` let it hide the employer from every query.
  Blank optional fields are now absent, and queries use `||`.
- **A cache that kept failures.** The KV key covered only name, location and occupation, and an empty or partial
  result was cached for 7 days. The key is now `search:v2:` over every intake field plus the link. Only complete,
  non-empty results are cached. Hard delete removes every key a mimic may have written, including the old format.
- **No way back.** The screen told people to add a link "when you start", after they had started. "Search with a
  link" (`POST /api/mimics/:id/identity/search`) now works while a choice is pending, with search consent, for up to
  4 distinct links. It moves `identity_state` to `searching` in one conditional statement
  (`Store.transitionIdentity`), so two requests at once start one search. Then it marks the open candidates
  `superseded`, puts the link first in `links`, and enqueues `identity.search` with an `attempt`, which gets its own
  ledger key.
  - `superseded` is a new candidate status. Those candidates weren't judged, so they never read as "not me"
    (`rejected`) in the data.
  - If the enqueue fails there is no ledger row for the cron to requeue, so the candidates and state are put back.
  - Only the newest link's profile leads the list and is tagged "Your link".
  - Confirming also moves the state in one statement, from `candidates` only, and only a candidate from the latest
    search can be confirmed. Status changes are one statement each, not one per row.
  - A redelivered search job that finds its candidates already in place finishes the move to `candidates`, so a
    run that failed after inserting them doesn't leave the person on the spinner.
- **Intake.** "Employer" is now "Employer or school", since a school is what finds a student. The column is still
  `employer`, and states and prompts are unchanged.

Jev ranking was already sound given the right profile: 0.93 and 0.68 for the two people, with at most 0.49 for
anyone else. Live after the change, five intakes for the two people (different wording, with and without the
employer or school) found the right profile every time: first in four, second in one. In that one, the school was
entered by a short name that is also a nearby city, and Jev preferred a local namesake. The screen therefore has no
"likely you" badge; order alone carries the ranking. Cost is unchanged at about $0.021 per search, 3 Exa queries
plus 10 Jev calls, and $0.001 more for a link.

The picker is a radio group (select, then "This is me"). Profiles below p = 0.2 are behind "Show more". The link
search sits under the list and on the "couldn't find" screen.

## ADR-0030 — Location and occupation autocomplete on `/new` (2026-09-30)

The location and occupation fields on `/new` suggest as you type. A location can be a city, a state or province, or a
country: "Cambridge, Massachusetts, United States", "Bavaria, Germany" or "Portugal". Suggestions only fill the text
field, and anything typed is kept, so a village or a title that isn't listed still works. The API and the `mimics`
columns don't change: both fields are still free text.

This departs from PLAN §9.1, which asked for "city and country". A country-only location makes the identity queries
(`"{name}, {role}, {location}"`, ADR-0029) and the baseline's context less specific, so the hint asks for a city first
and a state or country is the fallback for people who don't want to give one.

- **Data.** `apps/web/scripts/autocomplete/gen.mjs` (`pnpm --filter @mimic/web gen:autocomplete`) writes two static
  files to `apps/web/public/autocomplete/`, plus `lib/autocomplete-sources.json`, which is the attribution the form
  shows. All three are committed and deterministic. The script's directory is its own package, outside the
  workspace. It installs its ~80 MB of source data only when run, so CI and deploys never download it.
  - `places.v1.json` (~350 KB gzipped) holds 250 countries and 5,076 subdivisions from `@countrystatecity/countries`
    (dr5hn, ODbL). It also holds 24,686 cities from GeoNames via `all-the-cities` (CC BY 4.0): those with 15,000+
    people, plus capitals.
    - Each city takes its state from the nearest same-named dr5hn city, so the names agree.
    - The UK keeps only England, Scotland, Wales and Northern Ireland as its subdivisions.
    - A subdivision that is also listed as a country (Hong Kong SAR, Macau SAR, Puerto Rico, Taiwan, Kosovo) is left
      out, and so is a city that is its own country (Singapore, Monaco).
    - A few cities carry the names people type (NYC, SF, Bangalore, Kiev, DC). US, Canadian and Australian states
      match their abbreviations (TX, ON, NSW).
  - `occupations.v1.json` holds 6,813 titles from O*NET 30.3 "Sample of Reported Titles" (USDOL/ETA, CC BY 4.0).
    Titles longer than the 120 characters the server accepts are dropped. A short list O*NET lacks is added:
    student, founder, retired, data scientist… O*NET isn't on npm, so pass its text file with `--onet`.
- **Search** (`apps/web/lib/autocomplete.ts`). A field fetches its file the first time it is focused, validates it
  (zod/mini), indexes it (~150 ms once) and searches in memory. A lookup takes about 1 ms because only names with a
  word starting with the query's first two letters are scored.
  - Matching folds case, accents and letters like ł, ø and ı (`lib/norm.mjs`, which the generator shares), so
    "lodz" finds Łódź.
  - Tiers, best first: the start of a name or alias; a word inside a name; then a name followed by its region or
    country ("cambridge ma", "paris, france") or the words in any order ("engineer software").
  - Within a tier, bigger places rank first. A whole-name match counts three times its population, except for
    states, and a state weighs 0.4 of the population of its cities. So "new york" puts the city first and
    "georgia" the country.
  - Country codes are used only to narrow a search ("paris fr"), never to match on their own. If they did, "ma" or
    "to" would put Morocco or Tonga first.
- **UI** (`apps/web/components/autocomplete.tsx`). A WAI-ARIA combobox on downshift's `useCombobox`:
  - The menu counts as open only while it shows suggestions, so Enter submits the form unless a suggestion is
    highlighted.
  - Tab takes the highlighted suggestion; Escape keeps the typed text.
  - Typing updates the form synchronously. downshift's `onInputValueChange` runs one render late and dropped fast
    keystrokes.
  - The browser's own autofill is off on both fields (downshift sets `autocomplete="off"`); its popup would cover
    the list.

Rejected: a geocoding API (Photon, Mapbox). It sends what people type to a third party and needs a key and a network
dependency, and this environment's egress blocks it. Serving the data from a Worker route would add ~1 MB to the web
Worker for no gain.

## ADR-0031 — Link previews (2026-09-30)

A shared link used to unfurl as a bare title ("Mimic") and a generic compass icon: there was no `og:image`, and the
only icon was an SVG, which iMessage doesn't use. Every route now shares one preview.

- **The card.** The app's `OverlapMark` ("You" and "Mimic") over one question: "How predictable are you?" There's no
  subtitle, because it can't be read at chat bubble size. The title ("Mimic: a model that predicts how you decide")
  and the description under the image do the explaining. The description repeats the session's own promise (your
  mimic guesses before you answer) and claims no accuracy. The same description is now the page's
  `<meta name="description">`.
- **Picked with a rubric.** Four gates:
  - no personal data;
  - no unbacked claims;
  - a 1200×630 PNG under 300 KB with an absolute URL, size and alt;
  - no runtime cost.

  Eight weighted criteria, out of 48: thumbnail legibility, instant clarity, hook, simplicity, brand fidelity, crop
  safety, contrast on light and dark chat backgrounds, and copy. Eighteen variants were rendered over five rounds,
  each at full size, in iMessage-style bubbles on dark and light backgrounds, and as an 84 px square crop. An
  independent blind review scored the finalists, and the fog card beat an ink-field card, 46 to 38. A 2 px rule
  gives it an edge on white chat backgrounds. The headline fits WhatsApp's centered square crop.
- **Self-only, so no per-mimic previews.** A mimic's pages get the same card and title as the landing page. A preview
  never carries a name, answers or traits.
- **Static assets.**
  - `public/share-card.png` (about 44 KB) and `public/apple-touch-icon.png` are committed and served by Workers static
    assets, so the Worker never runs for them.
  - Pages link each image with a `?v=` content hash, computed in `next.config.ts`, because link previews cache
    images by URL.
  - Assets match `_headers` rules on the path alone, and iOS also requests `/apple-touch-icon.png` with no query, so
    both are cached for a day rather than marked immutable.
  - We didn't use Next's `opengraph-image` and `apple-icon` file conventions. They inline the PNG into the Worker
    bundle and answer each request through the Worker with `max-age=0`.
  - Next ignores file-based icons once metadata sets `icons`, so `icon.svg` moved from `app/` to `public/` too. It is
    no longer a prerendered route (ADR-0023).
- **The generator.** `apps/web/scripts/share-card/gen.mjs` (`pnpm --filter @mimic/web gen:share-card`) renders
  both images. Like the autocomplete generator (ADR-0030), its directory is its own package outside the workspace,
  so only a run installs Playwright; it needs `playwright install chromium` once.
  - It renders `OverlapMark` and `Mark` with react-dom/server and colors them with the light theme's tokens, read from
    `globals.css`, so a change to any of them reaches the images on the next run.
  - A font that fails to load stops the run instead of drawing a fallback.
- **The origin is set per environment at build time.** Previews need absolute image URLs.
  - `scripts/deploy` sets `SITE_URL` for the OpenNext build: the custom domain, or for preview the `workers.dev`
    URL on the account's subdomain.
  - `next.config.ts` inlines it into `metadataBase`, so `/new` stays prerendered.
  - Local builds fall back to `http://localhost:3000`.
  - The smoke test checks that `/` links a PNG on the deployed host, so a build without `SITE_URL` fails the deploy.

## ADR-0032 — Teaching the mimic directly: `kind = feedback` (2026-09-30)

On the mimic page, the person could only ask the mimic and then check its guess. Those playground answers are a
clean test set (§9.11) and never enter a state, so nothing the person said there taught the mimic. Now they can also
pick the right answer themselves, without asking.

- **A new question kind, `feedback`.** "Answer it myself" stores the question (drafted from a scenario or written by
  hand) and the chosen option in one D1 batch (`Store.recordFeedback`): the question is inserted already answered,
  `mimics.seq_max` advances, and the answer row is written. It carries no predictions and no `stateAt`, like a
  repeat. The prompt ID in its provenance is `feedback.v1`. Saving makes no model call.
- **The mimic learns from it; nothing scores it.** Four predicates in `types.ts` replace the hand-written kind
  checks. `learnsFrom` (anchor, adaptive, feedback) decides what enters sealed states and `learn.answer` (embedding,
  trait read, reflection). `isSessionKind` (anchor, adaptive, repeat) decides serving, progress and repeat
  scheduling. `isScoredKind` (anchor, adaptive) decides fidelity, shadows, backfill, coverage and replay targets.
  `isPredictedKind` (anchor, adaptive, playground) is what the lab's invariant monitor checks.
- **Invariant 2 is unchanged.** It covers questions served for the person to answer. Feedback is never served: the
  person writes the question and its answer together, so there is nothing to predict before it is returned.
- **Learnable answers still arrive in seq order.** Snapshots, reflection, trait writes (monotonic by `seqUpTo`) and
  the `everyN` cadence all assume it. The session keeps one question served and prefetched, so feedback often comes
  while a session question at seq t is still waiting for its answer. In that case the feedback takes seq t, and the
  same batch moves the open question to the next free seq. Its predictions were sealed below t, so they stay
  sealed. Two more changes support the move:
  - `loadMimicDataAt` also pins feedback evidence by answer time. A state then rebuilds exactly at the question's
    new seq, and feedback given within `STATE_SETTLE_MS` of a serve reaches the next state instead, as derived data
    does (ADR-0017).
  - An answer that races the move fails on the unique `(mimic_id, seq)` answer index, and `submitAnswer` records it
    again at the question's new seq.
- **Races over seqs.** A serve that loses its seq to feedback (session or playground, `serveAtFreeSeq`) keeps its
  predictions and takes the next free seq instead of predicting again or returning a 409. The answer that took the
  seq came after `stateAt`, so replay leaves it out too. A playground question is stored only once predicted, and is
  discarded if it can't be served, so nothing is left orphaned. `submitFeedback` retries up to 3 times.
- **Idempotent, and strict about it.** A retry with the same key returns the stored result. The same key with a
  different question or answer is refused. Choice and scale answers map to the renormalized keys by position;
  yes/no answers map by key in any order.
- **Budget.** Learning from feedback costs what learning from a session answer does. Once the budget is spent,
  `learn.answer` keeps the evidence, skips the model reads and still writes the snapshot, instead of failing until
  the job is dropped. This also covers the session answer that crosses the budget. The response says
  `learns: false`, and the page says the answer is saved rather than learned.
- **Snapshots.** A snapshot counts as current only if it holds every answer (same count, seq at least as high).
  Before, only the highest seq was compared, which missed an answer that arrived below it. That already happened
  when an asked question was answered while a session question below it was still open.
- **Repeats.** `minGap` counts session questions, not seqs. Questions written on the mimic page (feedback, and
  playground before this change) no longer shorten it.
- **Offline replay.** A checkpoint's state includes feedback given before it, as it did online, because the traits
  and insights as of that time already learned from it. The as-of time comes from the next predicted question, never
  from a feedback row. Existing data has no feedback, so every stored state and replay result is unchanged.
- **Privacy.** Feedback text is free text the person wrote, like playground prompts and `why`. Research exports keep
  it under `consent_research`, as they keep those (PLAN §12.4). Hard delete covers it with the rest of the evidence.
- **API.** `POST /api/mimics/:id/ask` takes `{ feedback: { question, answer, why?, idempotencyKey } }`.
  `GET /api/mimics/:id/ask` lists what was asked and taught, with counts (taught, checked, matched), reading only
  playground and feedback rows. Draft validation errors read as sentences a person can act on ("Two options say the
  same thing."). The word limit is shared with the client (`@mimic/core/limits`).
- **UI.**
  - The draft editor can add and remove options (2–5), switch between options and yes/no (the written options
    survive the switch, and a trip to answering and back), and start from a blank question.
  - Answers use the session's option buttons and scale, with 1–5, Y/N and Enter only when focus is on an option or
    on no control. Match, close and miss wording is shared with the session (`verdictOf`).
  - Each new card moves focus to its first control, with the usual visible focus ring.
  - Opening a question from the history waits for any request in flight. An asked question uses one idempotency key
    per pick, and shows the stored answer if an earlier attempt already saved one.
  - `mimic.json` (`mimic/1`) accepts `kind = feedback` in its evidence.

## ADR-0033 — Persona.md: a curated, portable portrait for any agent (2026-09-30)

`mimic.json` is a research artifact: it lets a predictor run against a person's state. People also want to bring
themselves to the agents they already use, which read prose, not trait vectors. `Persona.md` is that file: values,
beliefs, opinions and biases, and above all how the person thinks and decides. PLAN §8.3 describes it.

- **A view, not new evidence.** The file is built from the mimic's current data, the latest `persona.v1` draft and
  the person's curation. The deterministic sections need no model call, so the file downloads even before a draft
  exists. Curation filters and rewords the file only; nothing flows back into states, traits or predictions, so
  invariants 1 and 3 are untouched.
- **Live data, not the snapshot.** An earlier version read the latest snapshot through `exportMimic`, which writes one
  when evidence has moved. Every persona request could then write a snapshot mid-learning (freezing traits and
  insights from before the last answer, after which the debounced `snapshot.write` job had nothing to do), race that
  job for the version number, and keep showing a fact the person had removed until their next answer. The persona
  now reads the same fields live (`mimicDocParts`, shared with `buildMimicJson`), so viewing writes nothing.
- **One new prompt, `persona.v1`.** It runs on the reflector's model (the generator's when reflection is off) at
  `reasoning.effort: medium`, since it's a one-off per request and quality matters more than latency. Not adding a
  config field keeps every existing config hash valid; the draft row records the evidence seq it covers, config
  hash, prompt version, model and model snapshot instead (invariant 4). The call goes through the gateway
  (invariant 5) and the budget guard.
- **Citations or nothing.** Like the reflector, every statement must cite answers the writer was shown, or it is
  dropped, and at most six survive per section. Each statement is validated on its own, so one malformed item
  doesn't sink the rest. A statement with a single citation is marked tentative whatever confidence the model
  reports. Citations in the file point into the decision record at its end, and are shown only for answers that are
  in the file. The model is told to cite only in `evidenceSeqs`; inline references like "(#1, #2)" (seen in the first
  live run) are stripped, and bare numbers such as "(2019)" are left alone.
- **Data minimization.** The writer gets location, occupation, sourced facts other than `headline` (a search
  result's page title, which usually carries the name), tendencies, insights and answers. The display name and each
  part of it are redacted anywhere in that input. Draft text that mentions a fact the person later removes is left
  out of the file, and removing a fact also hides identical copies stored by another source.
- **Curation keys.** Draft items are keyed by content hash (`summary:` and `st:`), so a rewrite that changes one
  drops its edit and never lets an old edit mask new text. Everything else is keyed by a stable identity (`fact:`,
  `trait:{facet}`, `ex:{seq}`, `id:location`), and those keys are never pruned, so an item the person hid stays hidden
  when it drops out and comes back (a facet whose certainty dips, for example).
- **Ordered saves.** The page sends one save at a time and flushes an unsent change when the person leaves (a
  keepalive request). Each save carries an increasing `rev`; the upsert applies only when it is newer than the stored
  one, so a slow or late request can never overwrite a newer curation.
- **Shared labels.** Fact predicate labels and certainty tiers live in `@mimic/core/labels` (client-safe, like
  `@mimic/core/links`), used by the model panel, the identity page and the file, so the three agree.
- **Storage.** `persona_drafts` (append-only, one row per draft) and `persona_curations` (one row per mimic, with
  `rev`), migration `0004_persona`. Both are in the hard-delete scope. Research exports always drop curations, the
  person's own writing, and drop drafts whenever identity is scrubbed, since drafts are free text written from
  location and sourced facts.
- **Synchronous.** Drafting is a route handler call like the playground's, not a queue job: the person is waiting
  on the page for it, and it is one LLM call.

## ADR-0034 — Identity search and enrichment: cheaper, and on their own queue (2026-09-30)

The goal was the cheapest, fastest identity step that is still reasonably accurate. Each option was measured live on
the two ADR-0029 test people. The prices are Exa's and Parallel's published ones.

**Changed**

- **Search results carry their facts, so confirming costs nothing.**
  - Exa people search returns each profile's structured person entity: the current role and employers, past
    employers, schools and location. `exaCandidate` maps it to facts on the candidate.
  - The search stores them in one R2 blob (`search/{mimicId}/facts/{at}.json`, the candidate's `r2_key`).
  - Confirming such a candidate writes those facts, sourced to its URL, and goes straight to `review`: no
    enrichment call, no job, no wait.
- **Enrichment otherwise uses Exa, not Parallel** (`ENRICH_PROVIDER=exa`; `parallel` stays selectable).
  - Exa `/contents` returns the same entity for $0.001 in 0.2–0.6 s. A Parallel `base` task costs $0.010 and takes
    tens of seconds.
  - A readable page with no entity (a personal site) gets one more call: an Exa schema summary with Parallel's
    output schema ($0.001, 2.5–4.7 s). It is validated with zod, at confidence 0.6.
  - No second call when Exa couldn't read the page, or for a LinkedIn page without an entity. A summary of a
    LinkedIn profile listed things like "100Bs tokens" as skills.
  - Each call is logged as its own `model_calls` row (`exa:contents`, `exa:summary`). The gateway hands the
    enricher a per-call runner (`ProviderCallRunner`).
- **Entity facts, precisely.**
  - A role is current only when it has a start date and no end. Undated roles are past employers.
  - Schools are named alone, so "Pomona College" is one organization in the KG whatever the degree.
- **Two search queries, not three.** Given a role, the name-only query never found anyone the other two missed,
  and each query costs $0.007. It now runs only as a fallback: when the role queries find nobody with the person's
  full name (a role or school that isn't on their profile). Without a role, the queries are `{name}, {location}`
  and the name alone.
- **The person's link short-circuits search.**
  - When the link resolves to a profile with their full name ($0.001), searching as well would only add
    namesakes, so it is skipped.
  - The lookup gets a 1.5-second head start; if it is slower, or matches only part of the name, search runs
    alongside it.
- **Identity jobs have their own queue** (`IDENTITY_JOBS` → `mimic-identity`, same DLQ).
  - Cloudflare Queues adds consumers only after a batch finishes. On the shared queue, a 2-second search sat behind
    a `pool.refill` batch for 1 to 4 minutes, and so did enrichment.
  - Producers send `identity.search` and `identity.enrich` there by type alone.
  - The consumer, whose `ENRICH_PROVIDER` is the one that counts, forwards minutes-long Parallel enrichment to the
    shared queue.
  - Identity calls to Exa are bounded (search 10 s, page 8 s, one retry; summary 15 s, none), so one bad page
    can't hold the lane for long.
  - `/__jobs` enqueues through the same routing, and backfill publishes to the `JOBS` binding by name.
  - Deploy finds or creates the queue by name, like the others.

**Kept, after measuring**

- **Exa `auto` search.** Every search type costs the same, $7 per 1k.
  - `fast` (0.38 s median) and `instant` (0.29 s) found the true profile in 7 of 9 queries; `auto` (1.65 s) found
    it in 9.
  - The two misses were the hardest intake (a short school name that is also a city).
- **One Jev request per candidate.** One batched request with every candidate in a single state was about 0.4 s
  faster and $0.0001 cheaper per search. But it pushed the true profile from #1 to #2 in one case.

**Result.** Per person, with the listed prices:

| Path | Search | Rank (Jev) | Enrich | Total | Before |
| --- | --- | --- | --- | --- | --- |
| No link, profile from search | $0.014 (2 queries) | ~$0.0003 | $0 (carried) | ~$0.014 | ~$0.031 |
| Link that resolves | $0.001 (lookup) | ~$0.00003 | $0 (carried) | ~$0.001 | ~$0.032 |
| No full-name match (fallback query) | $0.021 | ~$0.0003 | $0 | ~$0.021 | ~$0.031 |
| Profile without an entity (personal site) | as above | | $0.001–0.002 | | |

On the local stack, with a 35-second `pool.refill` batch running on the main queue:

- search took 1.9 s;
- search with a link, 0.65 s;
- enrichment through Exa, 0.94 s. A candidate's carried facts need none.

A deploy-time `ENRICH_PROVIDER` set in Doppler overrides the new default (ADR-0022). Remove it, or set it to `exa`.

## ADR-0035 — Spend caps: a session share and a reserve for the mimic page (2026-09-30)

The budget guard stopped everything at `session.budgetUsd` ($0.50). A session that spent all of it left nothing for
the mimic page, so a person who finished the session could no longer ask their mimic a question or draft Persona.md,
the two things they finish the session to do.

- **Two caps from one budget.** The session may spend a share of the cap (`BUDGET_SESSION_SHARE`, default 0.8); the
  rest is a reserve for the mimic page. Past the share `/next` returns `budget`.
- **Enforced at the gateway, by purpose.** Every purpose an engine call is logged under has a spend scope
  (`SPEND_SCOPES` in `packages/core/src/gateway.ts`), and a test fails when a purpose in the engine is missing
  from it. `session` purposes (shadows, `pnpm backfill`, pool refills and gates, hypotheses, identity) are held to
  the share, so no background or research work can draw on the reserve. `page` purposes (asking, teaching,
  Persona.md, and learning from answers: embeddings, trait reads, reflection) run to the whole cap, so an answer
  taught after the session still updates the mimic. `serve` purposes (primary, baseline, fallback, BALD
  exploration) are admitted once by `/next` under the share and then held to the whole cap, so a serve that
  starts just under the share is never cut off halfway with a failed primary. An unlisted purpose is held to the
  share.
- **Refused jobs.** A job the guard refuses is skipped, not retried, and never marked done in the ledger, so the
  same job runs if it's enqueued after the cap is raised. Shadows, refills and hypotheses check the share before
  loading anything, and the cron stops enqueueing missing shadows for a mimic past its share.
- **Deploy settings, not config.** The caps change what a mimic may spend, never what a prediction sees, so they stay
  out of `PipelineConfig` and every config hash stays valid. A new config field would have meant `cfg.default.v5`
  and a new label on every question, just for a limit change. `BUDGET_USD` sets the standard budget (default $1,
  `DEFAULT_BUDGET_USD`). It applies to every config carrying $0.50, the budget every `cfg.default.*` has had, so
  mimics created earlier get it too, and one that stopped at $0.50 reopens its session. A config that names any
  other budget, such as an experiment arm, keeps its own, so arms stay comparable.
- **Defaults in code.** $1 and 0.8 are constants in `packages/core/src/config.ts`, used by the Workers, tests and
  the eval CLI alike. The Workers' vars only carry an override set in Doppler, and the live eval engine reads the
  same variables from its environment. Preflight refuses a non-number, a cap at or below 0, or a share outside
  (0, 1], and a test checks that it accepts exactly what the runtime accepts. At runtime a var may be a string or
  a JSON number; an invalid one keeps its default and is logged once.
- **UI.** `budgetUsd` in the snapshot is the whole cap. The session's end says what is left: the reserve for the
  mimic page, or, once everything is spent, that answers can still be taught there.

## ADR-0036 — Undo the latest answer (2026-09-30)

People mis-tap. The session page lets them take back their **latest** answer, once, and answer that question again:
"Undo" sits next to Next during the reveal, and "Undo last answer" shows on the question after it. Both open a
simple confirmation that names the question and the answer; while the undo runs the dialog can't be dismissed, and a
refusal stays in it with the reason (the undo and delete confirmations share one `ConfirmDialog`). `POST /api/mimics/:id/rewind { questionId }` does the work; the client names the
question it is undoing, so a double click or a stale tab gets a 409 instead of undoing something else. The button is
only offered for an answer this page sent and the server confirmed (not while it waits in the offline outbox), and
it is gone after a reload.

What an undo of the answer at seq *t* does, in one D1 batch:

- **The answer leaves the evidence.** It moves to a new `answer_rewinds` table (value, why, latency, whether the
  guess was revealed, idempotency key, when it was given and undone). Hard delete and research exports cover the
  table; exports scrub its idempotency keys like the answers'.
- **The question comes back as it was.** Same row, same seq, same sealed predictions: they were built from answers
  before *t* (PLAN §3.1), so they still are. Its scores and the fidelity rows from *t* on are deleted, and the
  re-answer is scored against the same predictions.
- **What was predicted from the retracted answer is discarded.** The next question is usually prefetched while the
  reveal shows, and its sealed state holds answer *t*. Every served, unanswered session question after *t* is marked
  `discarded` with `seq = null`, and its predictions are deleted (the model calls stay logged). The batch selects them
  by condition, not by the IDs the engine read, and returns them; each gets a fresh pool copy with a new ID (so shadow
  job keys don't collide), keeping `createdAt` so anchors keep their order, and its prompt embedding. A repeat probe
  is dropped, since the repeat schedule picks it again.
- **Derived state from *t* on is rolled back** (PLAN §3.3), so the re-answer is learned from scratch and the
  monotonic writes don't block it: trait history rows with `seqUpTo ≥ t` are deleted and `trait_estimates` is rebuilt
  from what remains with the same query serving and replay read; insights with `seqUpTo ≥ t` are deleted with their
  KG edges; insights that reflection superseded are restored (`insights.superseded_seq` records which reflection did
  it); reflection facts from a reflection at *t* or later are deleted whatever they cite (`facts.seq_up_to`; older
  rows by the seqs they cite), with their KG edges and vectors, then reflection nodes left without an edge; persona
  drafts covering seq ≥ *t* (ADR-0033) are deleted and drafted again on request; the Q&A vector for *t* and
  hypotheses from *t* on are dropped.
- **The mimic's `evidence_epoch` goes up by one.**

**The batch decides, not the reads before it.** The engine checks the request first (latest session answer, one
step only, nothing asked or taught since) for a clear 409, but the batch re-checks what matters atomically: its first
statement records the rewind with `value` taken from a subquery that is NULL unless the answer still exists and
nothing was answered, asked or taught after it. `value` is NOT NULL, so otherwise the whole batch aborts (a D1 batch
is one transaction) and nothing changes. No trigger, no extra round trip; the same trick guards the other writes
below. A second undo of the same answer fails on the unique `answer_id`.

**Evidence epoch.** Every write built from data read before an undo must not land after it. Rather than re-checking
in each writer, derived writes and serves go through `Store.guarded(mimicId, epoch)`, which puts a guard statement
first in the batch: it sets `mimics.updated_at` to itself, or to NULL (aborting) when `evidence_epoch` has moved on.
A refused write throws `StaleEvidenceError` and writes nothing. Guarded:

- *Serving* (`serveQuestion`, session and repeat): a serve built before the undo is refused and built again, so
  nothing stale is ever served, and `/next` makes no extra read to check.
- *`learn.answer`*: trait upserts, reflection (insights, supersessions, facts, KG) and occupation facets. The job reads
  the epoch once; a job whose answer is gone is a no-op, and one refused by its own answer's undo is marked done (a
  retry would be refused again). One refused by the undo of a *later* answer, whose own answer stands, fails and is
  retried. Vectors and KV can't join a D1 batch, so after its writes the job re-reads the epoch: if it moved, it
  makes the Q&A vector match the answer now at that seq (or removes it), and reflection drops the vectors of facts
  it wrote. Hypotheses are taken back the same way unless a newer set replaced them.
- *Fidelity* after an answer, *snapshots* (retried once), and *persona drafts* (a 409 asks to try again).
- `learn.answer` carries `answerId` in its key; `snapshot.write` and `hypotheses.refresh` carry the epoch, so jobs
  queued before an undo never stand in for the re-answer's (old keys still parse).

**Answers can't land on a discarded question.** `recordAnswer` takes the answer's seq from its question, still
served at that seq, in the same statement. An answer that raced an undo (or feedback that moved the question,
ADR-0032) aborts, and `submitAnswer` re-reads the question and returns 409. An idempotency key that was undone also
gets a 409, so a retrying outbox or another tab can't bring the answer back.

**Scores.** A score takes its `mimic_id` from its answer in the same statement, so a shadow scoring an answer undone
meanwhile writes nothing. Found while testing, and older than undo: a shadow that inserts after the answer lists
predictions, and looks for the answer before it is recorded, was scored by neither; `submitAnswer` now lists again
after recording (deferred) and scores the stragglers (never `hypothesis` rows). A shadow that lands on a question
discarded while it ran deletes its own prediction.

**Snapshots.** A snapshot taken before an undo still holds the retracted answer, and after a re-answer it has the
same answer count and seq, so ADR-0032's count check can't see it. `writeSnapshot` also treats a snapshot older than
the last undo as stale. Its `createdAt` is now taken before it reads.

**Research caveat.** A re-answer can be influenced by the guess the person saw before undoing. `answer_rewinds`
marks every re-answered seq and whether the guess was revealed, so analysis can exclude or compare them. Headline
fidelity counts the re-answer like any answer.

Schema: `answer_rewinds`, `mimics.evidence_epoch`, `facts.seq_up_to`, `insights.superseded_seq`
(migration `0005_answer_rewinds`).

## ADR-0037 — Backfill accuracy: failure kinds, bounded retries, paced and deduplicated runs (2026-09-30)

After the ADR-0025 backfill, the lab showed Qwen3.8 Flash with 142 failed predictions (78%) and a p50 of 35 s, and
MiMo V2.6 Flash at 7.8 s. Some of that is the models, and some was how the backfill ran and what it recorded.

**What was the model.** Live `predict.v1` calls, sent one at a time on 8 sealed states from an offline session,
measured:

| Model | Latency | Result |
| --- | --- | --- |
| Qwen3.8 Flash (`effort: low`, 3000 max tokens) | 21–67 s | 3 of 8 spent all 3000 tokens on reasoning and returned no content (`finish_reason: length`) |
| Qwen3.8 Flash (`effort: low`, 8000 max tokens) | 18–104 s | 7 of 7 valid, with up to 4.5K reasoning tokens; plus one HTTP 429 from Alibaba |
| Qwen3.8 Flash (`effort: none`) | 1.7–2.7 s | 8 of 8 valid, no reasoning tokens |
| MiMo V2.6 Flash | 3–11 s | one of 8 was "Provider returned an empty response", in a 200 |
| GLM 5.3 Flash | 1–3.5 s | 8 of 8 valid |

So Qwen's latency is real at `effort: low`: its provider doesn't cap reasoning at that effort. Its failures were
mostly the 3000-token cap, recorded as "invalid JSON output". Whether to give it more tokens, run it with reasoning
off (a prompt variant, ADR-0028) or drop it is a separate decision; this ADR doesn't change the predictor.

**What was the backfill.**

1. **Failed calls were stored as the model failing, forever.** A 429 or a provider error made `LlmPredictor` return
   a failed prediction, and `runShadow` stored it and marked the job done, so nothing ever retried it. The budget
   guard did the same on a mimic near its $0.50 session cap.
2. **Latency counted retries.** Adapters timed a call from before the first attempt, so a success after a 429
   included the failed attempt and the backoff.
3. **No pacing.** Each run enqueued every prediction at once, which draws rate limits and slower answers, and queues
   ahead of live sessions' jobs.

**Decisions.**

- **Failures have a kind, stored with the prediction** (`predictions.error_kind`, main's `errorKind` plus one):
  - `output`: the model answered but the answer was unusable. Invalid JSON, options not covered, Jev's missing or
    wrong-typed answer, and now named cutoffs: `output cut off at max_tokens (…)` when `finish_reason` is `length`,
    and the provider's content filter.
  - `timeout`: the model didn't answer within the call's timeout. Chat calls no longer retry a timeout in-request
    (`retryTimeouts: false`): a retry bills a second generation and would record only the fast answers.
  - `transport`: the call failed before the model answered. `retryable` says whether it may succeed later: rate
    limits, 5xx, network errors, malformed responses, a 200 carrying an OpenRouter `error` body or a choice with
    `finish_reason: error`. The budget guard and other 4xx are not.
  - `output` and `timeout` are the model's: stored at once, counted, never redone. The optimizer still treats a
    timeout as transient, as before.
- **Retries are bounded.** A retryable failure makes `runShadow` throw so the queue retries it with backoff. On the
  last attempt (`MAX_JOB_ATTEMPTS`, from the ledger) it's stored as a `transport` failure instead. The cron's
  missing-shadow repair then sees the row and stops; it also skips a live shadow whose job used up its attempts.
- **Latency is the attempt that answered.** `requestJson` returns it with `attempts`, and `model_calls.attempts`
  records how many HTTP attempts each call took, so retry pressure stays visible.
- **Backfill predictions are `backfill.shadow` jobs, keyed without a run** (`backfill.shadow:{mimic}:{question}:
  {predictor}`), so the ledger dedupes them across runs. They are logged as `predict.backfill`.
- **Pacing.** `backfill.predictor` enqueues them for every (consented) mimic, `60 / perMinute` seconds apart as one
  stream (default 30 a minute per predictor, `--rate`), through `enqueueBatch` (Queues' `sendBatch`, 100 at a
  time). `backfill.mimic` does the same for one named mimic from `offsetSeconds`; the CLI staggers several.
- **Run limits.** A run enqueues at most 5,000, and nothing delayed past 12 h (`backfillLimit`). The CLI says when
  a run stops there, and a re-run enqueues the rest. The options are part of the job keys, so a job the cron
  requeues from the ledger keeps its rate.
- **In flight.** Each prediction is written to the ledger as `queued` (a new status) due at its time before it's
  sent. The missing rule, in the engine and the CLI, skips a question whose live or backfill shadow job is queued,
  running or being retried, and not stale. So a re-run never doubles the pace, and neither the cron nor a backfill
  races a live shadow. A queued job still not done 15 minutes after its time is stale, and the cron requeues it,
  which also repairs a lost message.
- **One shadow per question and predictor.** The partial unique index `predictions_shadow_uq` makes a concurrent
  second run of the same shadow a no-op (`Store.insertShadow` returns whether it stored). The migration first
  keeps the best of any existing duplicates: ok first, then the earliest.
- **Legacy failures are classified in the migration:** Jev's `Error: Expected …`, the two LlmPredictor messages and
  a missing answer are `output`; anything that timed out is `timeout`; the rest is `transport`.
- **Backfills are held to the session's share of the budget, like shadows** (ADR-0035). A mimic that has spent it
  is skipped when a run is planned, and a backfilled prediction it refuses is skipped, not stored. The calls are
  logged as `predict.backfill` (session scope).
- **Consent is checked again when each prediction runs**, since a paced run can span hours. Named mimics
  (`--mimic`) skip the check unless `--consented`.
- **`--retry-failed`** redoes this predictor's `transport` failures, carried on each job. `insertShadow` deletes
  the failed row and stores the new one atomically, and deletes only failed shadow rows, never primary or baseline
  ones.
- **The dry run explains failures.** It splits them by kind and lists the most common messages. It also reports
  predictions in flight, estimates cost from every charged prediction (unusable output included), and gives the
  duration and any run limit at the chosen rate. `packages/eval/test/backfill.test.ts` runs the CLI's SQL against
  the real schema, checks it against the engine's rule, and checks the CLI's copies of the engine's constants.
- **Queue batches still run all their jobs at once.** Capping them would make live jobs wait behind slow shadows.
  Pacing keeps backfill batches small; a live burst larger than six calls waiting on headers can still add a
  little queueing to a shadow's latency.

## ADR-0038 — Qwen3.8 Flash runs with reasoning off: `predict.v1-direct` and `cfg.default.v5` (2026-09-30)

ADR-0025 added `llm:qwen/qwen3.8-flash` as a shadow after one live call. At the incumbent harness (`reasoning.effort:
low`, 3000 max tokens) its provider doesn't honor low effort. ADR-0037's measurements on 8 sealed states:

| Qwen3.8 Flash | Valid | p50 | $ per 1k |
| --- | --- | --- | --- |
| effort low, 3000 max tokens (`predict.v1`) | 5 of 8; the rest spent all 3000 tokens reasoning | 59 s | $1.07 |
| effort low, 8000 max tokens | 7 of 7 | 49 s | $1.20 |
| reasoning off (`predict.v1-direct`, through `LlmPredictor`) | 7 of 8; one keyed an option by its label | 1.8 s | $0.07 |

The prod lab agreed: 78% failed, 35 s p50 over what did succeed. Almost every failure is the token cap, which also
makes the successes a biased sample: the questions Qwen happened to reason about briefly.

**Decision.**
- **A registered prompt variant, `predict.v1-direct`:** the incumbent `predict.v1` text with `harness.reasoningEffort:
  'none'`. It changes nothing but the effort, so it is addressable for any model as `llm:<model>@predict.v1-direct`
  (ADR-0028), and every prediction stores it as its prompt version (invariant 4).
- **`cfg.default.v5` is `cfg.default.v4` with the Qwen shadow as `llm:qwen/qwen3.8-flash@predict.v1-direct`.** The
  other shadows are unchanged. At effort low they reason for only tens to a few hundred tokens, so reasoning off is
  the closest match for Qwen to the condition they run in. Configs are immutable: mimics created under v3 and v4 keep
  `llm:qwen/qwen3.8-flash`, and its predictions stay in the record (with their failures now marked `output`,
  ADR-0037).
- **Backfill the new predictor** over served questions (`pnpm backfill --predictor
  llm:qwen/qwen3.8-flash@predict.v1-direct`, ADR-0024), so the lab compares it on the same questions as the others.

Whether reasoning helps Qwen's accuracy at all is left to the lab. `llm:qwen/qwen3.8-flash` remains as a
predictor ID, and the 8000-token harness can be registered as its own variant if that comparison is wanted.

## ADR-0039 — SOUL.md: Persona.md renamed, and redesigned from research (2026-09-30)

`Persona.md` (ADR-0033) is now `SOUL.md`. The rename came with a research pass on what the file should hold. What we
found, and what we changed:

- **SOUL.md already means something to agents.** In OpenClaw and Hermes Agent, SOUL.md is the agent's *own*
  identity, injected first into every system prompt; a model of the user goes in USER.md. Dropped in unchanged, a
  file about a real person would make the agent believe it is that person. So the file opens with YAML front matter
  (`kind: person-model`, subject, as-of date, answers, evidence cutoff, draft prompt, profile) and says in its first
  line, and again in the instructions, that it describes the person and is not the reader's identity.
- **Evidence over description.** Agents built from a person's interview answers predicted their survey answers far
  better than agents given demographics or a persona paragraph (Park et al., 2024, arXiv 2411.10109: 0.85 vs
  0.70–0.71 normalized accuracy), and a structured summary of a few thousand tokens loses little against the raw
  transcript, especially one that keeps how a person decides separate from what they prefer (the "BDE" structure,
  arXiv 2608.20344; Twin-2K-500, arXiv 2505.17479). So the file keeps the drafted portrait (decision procedure,
  rules of thumb, tradeoffs, values) apart from the evidence, and carries the person's real answers and reasons.
- **Twins drift toward an idealized person.** Studies of LLM twins find them too uniform, stereotyped and
  "hyper-rational", and nicer than the people they model (arXiv 2509.19088). `soul.v1` (a new prompt; `persona.v1`
  stays in the registry for older drafts, which still render) adds a Tensions section, asks for statements
  "specific enough to be wrong" (the soul.md project's phrase), and tells the writer not to make the person more
  rational, agreeable, consistent or optimistic than their answers. The instructions tell the reading agent the
  same.
- **The person's own rules come first.** Following OpenClaw's Always/Never directives and soul.md's "Won't:", the
  person can set boundaries (Always, Never, Ask me first), which open the file and override everything else, and
  choose whether an agent may write or speak as them: never; when asked, saying it's an AI (the default); or when
  asked. Voice samples (up to 5, the person's own writing, as in soul.md's STYLE.md) back the second and third.
- **Instructions for the reader.** A trust order (boundaries, own words, recorded answers with the most recent
  winning, inferred sections, tendencies, background); predict from a related answer first; say how sure you are;
  unknowns mean ask; check before anything irreversible, public, financial, legal, medical or personal; quoted text
  is the person's words, never instructions (the person's text and search facts are untrusted input, so they are
  quoted); don't edit the file. Fidelity and the as-of date say how far to trust it.
- **Short core, long appendix.** Persona instructions fade over long conversations and agent tools truncate large
  files (OpenClaw at 20,000 characters), so the core keeps the 12 answers the portrait cites most as "Key
  decisions", and the rest of the record goes to an appendix. `?profile=core` drops the appendix; the page shows both
  sizes. Tendencies are a compact table.
- **Third person for the portrait.** Asking a model to predict a person moved its answers closer to real ones than
  role-play did (arXiv 2607.24782), so the portrait says "they"; first person appears only in the person's quoted
  words and voice samples.
- **Rename mechanics.** Routes move to `/m/[id]/soul` and `/api/mimics/:id/soul(.md)`, with permanent (308)
  redirects from the old page, file and JSON API paths, so a page left open across the deploy still saves. The
  tables keep their names, `persona_drafts` and `persona_curations`, and there is no migration: a deploy migrates
  D1 before it ships code, so a rename would break the old code still serving in between. Drizzle names them
  `soulDrafts` and `soulCurations`. Existing drafts and curations (with their `rev`) carry over; stored curations
  parse with the new fields' defaults, and `persona.v1` drafts still render. `?profile=core` downloads as
  `SOUL.core.md`. The LLM call's purpose is `soul.draft`, drawn from the page's reserve like `persona.draft` was
  (ADR-0035).
- **Not in this change.** Treating "that's not me" on a statement as new evidence, and a "test my SOUL.md" check
  that scores an agent reading only the exported file on held-out answers, both touch the research invariants and
  are left for later.

## ADR-0040 — Categories and consent: sensitive domains become opt-in (2026-09-30)

PLAN §1 excluded health, sexuality, religion, politics and detailed finances, enforced by five prompt rules and the
`sensitive` Jev gate. The project owner now wants them, gathered as fully as each person permits, and wants people to
steer what they are asked about. This ADR lifts the non-goal and records the contract; `docs/CATEGORIES.md` is the
full policy.

- **Four categories.** Every facet has a `category`: Personality and psychology, Values beliefs and politics,
  Relationships sexuality and life, Work and money. All are selected by default and each can be deselected at intake
  or later; at least one stays. Question domains stay a separate axis (the kind of scenario, not what is measured).
  In v1, `spending_style` is "Work and money" although its group is Everyday, so a facet keeps one category across
  ontology versions; occupation facets are always "Work and money".
- **Five opt-in areas,** each a separate consent under its category: politics, religion, sexuality, health, money.
  A facet with `sensitive` set is reachable only with its area consented. Each consent carries a one-line reason and
  "Your answers stay yours: they are only used to build your mimic."
- **Special-category data** (politics, religion, sexuality, health) leaves research exports unless the person also
  consents to research use of that area; money follows plain research consent. None of it is ever taken from web
  search or enrichment: those fields are never requested, and a lexicon drops any fact that reveals one before it is
  stored. Hard delete covers it like everything else.
- **Direct questions only.** A sensitive facet is populated only by answers to questions that ask about it directly;
  nothing is inferred from other answers or from facts. The reflector is told so and code enforces it (ADR-0043).
- **Stored as a `MimicScope`** in `mimics.categories_json`, `consents_json`, `research_consents_json` (NOT NULL with
  constant defaults, so existing rows read as every category and no sensitive consent, which is what they were asked)
  and `scope_at` (migration 0007). `normalizeScope` keeps categories in canonical order, only `true` flags, drops
  consents of deselected categories (reselecting asks again) and research consents without the area's consent or
  research consent overall.
- **Enforced in code, from one place.** `facetsFor` returns scoped facets by default; `{ scoped: false }` is only for
  code that must know what is blocked. The loaders build a `ScopeView` and leave out answers to questions touching a
  blocked facet, blocked trait estimates, insights naming a blocked facet or citing a hidden answer, and reflection
  facts citing a hidden answer, so no state, belief, snapshot or view sees them. With the default scope nothing is
  blocked and every state hash is unchanged. Anchors are seeded only inside the scope (a person without "Relationships,
  sexuality and life" gets eight), and serving filters anchors, repeat sources, the pool and the reserve bank. The
  generator sees only scoped facets, and `validateDraft` rejects a draft tagging a blocked facet instead of dropping
  the tag. Occupation facets are generated only with "Work and money" selected.
- **Changing it later** (`setScope`). Narrowing stamps `scope_at` and discards every pooled or served-but-unanswered
  question now out of reach; what was learned in that area is hidden from then on (rows stay until hard delete).
  Widening changes no stored data. Hidden data is not time-travelled back into rebuilt states (privacy over replay,
  as for removed facts in ADR-0017); replay reports states served before `scope_at` as `rescoped`.
- **Scripted people are marked.** `runSession` gives scripted mimics a `script:` participant id (Twin imports already
  use `twin2k:`), so reports can keep real people apart (rubric R10).
- **Milestones.** M9 (this ADR: the policy, storage and scoped facets) through M13 (ADR-0045); PLAN §14 lists them
  and the rubric each is scored on.

## ADR-0041 — Reasoning budgets and caps per model, pinned option keys, calibrated Jev derived: `cfg.default.v6` (2026-09-30)

**Why.** The first Actions → Optimize report on prod data (3 consented people, 232 scored questions) showed two things:

- **Qwen3.8 Flash failed most of its predictions**: only 59 of 78 on the dev person and 20 of 154 on the test people
  succeeded. It ignores `reasoning.effort` and reasons without a limit, so on long states its thinking ran past the
  shared 3,000 `max_tokens` cap and the JSON never arrived (ADR-0037 measured the same).
- **Jev is overconfident.** A calibration temperature of 4 (the top of the old grid), fitted on the dev person, took
  held-out log loss from 1.804 to 1.124 nats per question and ECE from 0.267 to 0.098 on the two test people. The
  LLM shadows' fitted temperatures were all 0.9–1.2, so they need no calibration.

ADR-0038 answered the first by turning Qwen's reasoning off (`cfg.default.v5`). This ADR keeps reasoning on for
every model instead, at one low setting each, chosen for cost and accuracy together. Where a model ignores the effort
level, it gets a token budget. That way the shadows compare like with like. v5's reasoning-off Qwen stays in v6 as a
control arm, so real answers show whether reasoning helps Qwen. ADR-0038 left that question to the lab, and the
control costs about $0.00007 a question.

**Measured.** 8 long states (seq 45–72, from two scripted 72-turn sessions) per model and setting. The response cap
was 8,000 so nothing truncated. These runs measure token use, latency and whether the JSON is valid; they say nothing
about accuracy.

| Model | Setting | Valid | Reasoning tokens p50 / max | Completion max | Latency p50 | $ per prediction |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-6 Luna | effort low | 8/8 | 86 / 103 | 169 | 2.7 s | 0.00039 |
| GPT-6 Luna | effort medium | 8/8 | 105 / 134 | 200 | 3.6 s | 0.00041 |
| DeepSeek V4.1 Flash | effort low | 8/8 | 850 / 1,577 | 1,631 | 14.0 s | 0.00057 |
| DeepSeek V4.1 Flash | effort medium | 8/8 | 741 / 1,099 | 1,136 | 14.3 s | 0.00051 |
| GLM 5.3 Flash | effort low | 8/8 | 29 / 44 | 101 | 1.7 s | 0.00043 |
| GLM 5.3 Flash | effort medium | 8/8 | 30 / 57 | 110 | 1.1 s | 0.00017 |
| MiMo V2.6 Flash | effort low | 7/8 | 163 / 221 | 295 | 8.4 s | 0.00039 |
| MiMo V2.6 Flash | budget 1,024 | 8/8 | 152 / 253 | 283 | 9.6 s | 0.00039 |
| Qwen3.8 Flash | effort low | 7/8 | 1,787 / 4,213 | 4,326 | 40.9 s | 0.00130 |
| Qwen3.8 Flash | budget 512 | 7/8 | 512 / 512 | 659 | 13.2 s | 0.00070 |
| Qwen3.8 Flash | budget 1,024 | 8/8 | 886 / 1,024 | 1,087 | 19.0 s | 0.00049 |

Medium effort barely changes how much Luna, DeepSeek and GLM reason; on DeepSeek it reasoned less than low. Low is the
cheaper setting and the one every stored prediction used, so the comparison with history stays clean. MiMo Flash and
Qwen Flash list only `reasoning` on OpenRouter, not `reasoning_effort`, so they take a token budget. On Qwen, 1,024 is
the smallest budget that kept every answer valid, and it costs less than half of effort low.

**Checked end to end.** I then ran `evaluate --predictor <id>@predict.v2` on 120 states from the same sessions, once
per shadow. The live smoke cost $0.36 in total, including the reruns below.

| Shadow | Completion p50 / p95 / max | Failed |
| --- | --- | --- |
| GPT-6 Luna | 130 / 211 / 244 | 0 |
| DeepSeek V4.1 Flash | 717 / 1,707 / 3,094 | 0 |
| GLM 5.3 Flash | 84 / 140 / 1,500 | 1 (then 1 in a rerun) |
| MiMo V2.6 Flash | 204 / 345 / 550 | 0 |
| Qwen3.8 Flash | 874 / 1,119 / 1,131 | 7 (then 1 in a rerun) |

The checks turned up three things:

- **Two long tails.** DeepSeek reached 3,094 tokens, which would have truncated under the old 3,000 cap. In one call
  in 240, GLM reasoned all the way to its first 1,500 cap; its next largest completions were 1,342 and 1,005.
- **Labels as keys.** Qwen's seven failures, and one of GLM's, were valid distributions keyed by option labels. On
  0–4 scales they wrote "Never", "Often" and so on instead of "0" to "4".
- **One degenerate loop.** After the label fix, Qwen's one failure listed invented option keys (a to z, then aa and
  on) until it hit the cap. A larger cap would only make that failure cost more.

Both key problems come from the schema, which let `key` be any string. With the key as an enum of the options
(`keyEnum`), a final round of the five shadows over the same 120 states each had these results across 602 calls:

- 0 failures and 0 truncations;
- 0 keys outside the enum, so every provider enforces it;
- largest completions all under their caps (DeepSeek 2,382, GLM 1,380, Qwen 1,178).

**Decision.**

- **`ChatRequest.reasoningMaxTokens`** is sent as OpenRouter `reasoning.max_tokens` and wins over the effort. Only one
  of the two is ever sent, and `max_tokens` still covers reasoning and answer together.
- **The prompt harness gains `reasoningMaxTokens`, `calibrationTemperature`, `keyEnum` and `labelKeys`.**
  - `calibrationTemperature` post-scales a predictor's distribution: p ∝ max(p, P_FLOOR)^(1/T).
    - It keeps the argmax, so top-1 accuracy, and item accuracy on choice and yes/no questions, don't change.
    - Score questions are scored by expected index, and a temperature above 1 moves that toward the middle of the
      scale. This helps a confident miss and costs a confident hit.
    - The stored report's fits show test accuracy before and after, next to log loss. Check that column before
      promoting a calibrated primary.
  - `keyEnum` makes the answer's `key` field an enum of the question's option keys, in a per-question JSON schema.
    With the strict schema that is already required, a provider that enforces it can't return labels or invent
    options.
  - `labelKeys` re-keys an LLM answer from option labels to option keys, as a fallback for a provider that doesn't
    enforce the enum. It applies only when every option is then covered by exactly one entry, so a partial or
    ambiguous answer still fails.
  - All four default to the incumbent's behaviour (no budget, T = 1, a plain string key, keys only), so every
    existing prompt version, config hash, request and stored prediction is unchanged. Each request carries one
    reasoning control (`reasoningOf`), and a budget of 0 is sent as 0, not dropped.
  - A resolved harness must leave at least 256 tokens for the answer after a reasoning budget (`harnessProblems`).
    Registered variants are checked by a test, candidates are refused before anything is spent, and predictor IDs
    are refused on parse.
  - Eval candidate hashes include the full harness, so they do change. An optimize run directory from before this
    change can't be resumed, and its cached predictions are paid for again.
- **A registered variant may set reasoning control and caps per model** (`modelHarness`, only
  `PER_MODEL_HARNESS_KEYS`), resolved as incumbent → variant → model. A variant that has them runs only on the models
  it lists: `predictorIdProblem` refuses any other model, in configs, backfill and the optimizer. So a new model, or
  a routing variant like `:nitro`, gets measured settings and never silently falls back to the incumbent's effort
  and 3,000 cap, which is the failure this ADR fixes.
- **`predict.v2`**: the incumbent prompt text with `keyEnum` and `labelKeys` on, plus the settings below, for these
  five models only.

  | Model | Reasoning | `max_tokens` |
  | --- | --- | --- |
  | GPT-6 Luna | effort low | 1,500 |
  | DeepSeek V4.1 Flash | effort low | 6,000 |
  | GLM 5.3 Flash | effort low | 3,000 |
  | MiMo V2.6 Flash | budget 1,024 | 2,048 |
  | Qwen3.8 Flash | budget 1,024 | 2,048 |

  The cap rule:
  - For an effort model, the cap is about twice the largest completion seen in both measurements, and at least
    1,500.
  - For a budget model, the cap is twice the budget.

  A cap guards against runaways, and it is not a price. A normal call costs the same under any cap, and a truncated
  call is billed for its whole cap and then fails. So a generous cap costs almost nothing, and one that is too tight
  wastes the call.
- **`jev-predict.v2`**: Jev's incumbent templates at T = 4. It is registered, but it is not a default shadow.
  - As a shadow it would send a second, identical Jev request on the primary's sealed state. CLAUDE.md says to batch
    Jev questions that share a state, and the comparison would pick up Jev's run-to-run noise (about 0.03 nats).
  - Instead `evaluate --from stored` derives it: every registered Jev variant that differs from the stored primary
    only by calibration temperature gets rows with the role `derived`, from the primary's own answers rescaled.
    Those rows appear in every table (by split, person and question type, with accuracy and lift), at no cost and
    with no noise.
  - It remains the seed for Jev template search, and the version to name when calibration is promoted to primary.
- **`cfg.default.v6`** is v5 (ADR-0038) with its five LLM shadows on `@predict.v2`, plus v5's
  `llm:qwen/qwen3.8-flash@predict.v1-direct` kept as the reasoning-off control. The primary stays uncalibrated Jev.
  `predict.v1-direct` sets no per-model settings, so it stays valid for any model.

  New mimics get v6. Existing mimics keep their config, and `pnpm backfill` gives their served questions the new
  shadows (ADR-0024).
- **The calibration grid in `evaluate --from stored` now runs 0.25–16 (46 steps).** This is because the old top of 4
  was the fitted value. Pooling fits pair the primary with LLM shadows only, since a Jev shadow pooled with the Jev
  primary is a temperature fit under another name.
- **Actions → Optimize seeds from `jev:typesafe/jev-1.13@jev-predict.v2` by default,** so GEPA searches templates on
  top of the calibration and not against it. Its caps:
  - 30 iterations (now a workflow input) and 2,500 metric calls. Each iteration is two minibatches and a
    validation pass.
  - The run stops at whichever cap it reaches first. For a Jev seed at the defaults, that is the 30 iterations,
    after about 2,400 predictions and roughly $0.7–1.3, well under the $2 `max_usd`.
  - `--max-minutes 140` stops the loop cleanly inside the job's 180-minute timeout. No iteration starts that might
    not finish, with as long again kept for the holdout.
  - The result is uploaded even after a cancel or timeout.
- **The optimizer's `PREDICT_PROMPTS` snippet starts from the seed variant's harness and adds the run's changes.**
  - A change to reasoning or a cap goes under the optimized model's `modelHarness` entry, so a setting measured for
    one model never reaches another.
  - Any other change (the schema, keys, calibration) describes the prompt, so every model shares it.
  - The seed's entries for the other models are carried over, so the winner can replace the seed on every shadow.

**Why not promote calibrated Jev to primary now.** It was fitted on one person and checked on two. The derived rows
give the evidence on every new question: log loss, and accuracy per question type, since calibration changes accuracy
on score questions. Promoting it later is a one-line config change (`primary: jev:typesafe/jev-1.13@jev-predict.v2`).
The pooling fits also put almost no weight on the primary against any LLM shadow, which is worth revisiting once
`predict.v2` has been backfilled.

**Cost.** At the table's prices, the v6 shadows cost about $0.0023 per scored question together:

| Config | Shadows' cost per question | Compared with v6 |
| --- | --- | --- |
| v4 | $0.0031 | a quarter more, because Qwen's unbounded reasoning was the costliest |
| v5 | $0.0019 | $0.0004 less, because Qwen doesn't reason |
| v6 | $0.0023 | — |

Calibrated Jev costs nothing. Backfilling the five `predict.v2` shadows over the 232 questions served so far costs
about $0.53.

## ADR-0042 — Ontology v2, reserve.v2, gen.v3 and gates.v3: concrete, broad, consented questions (2026-09-30)

Sessions opened with self-ratings, leaned on work (`domainMix` put 45% on professional scenes and `gen.v2` grounded
them in the occupation: in a live sample, 8 of 20 gen.v2 drafts for a nurse were set at work, none of them measuring a
work facet), and the ontology had nothing on morality, emotion, motivation, attachment, beliefs about the world or
money psychology. ADR-0040 made sensitive areas opt-in, but there were no facets to ask about. This ADR adds them,
and makes concreteness and respect things a gate checks rather than things a prompt asks for.

- **Ontology v2** (`packages/core/src/ontology/v2.ts`): 67 facets in ten groups, each group in one category.
  Every v1 facet keeps its id, poles, labels and category; only its group changes. 34 facets are new:
  - Emotion and motivation (psychology): emotion regulation, emotional expressiveness, sensitivity to setbacks,
    reward drive, need for cognition, growth mindset, self-control.
  - Values and morality (values): the five moral foundations of the MFQ (care, fairness, loyalty, authority) plus
    liberty, honesty-humility and rule following.
  - Beliefs and worldview (values): locus of control, optimism, belief in a just world; sensitive: political
    leaning, political engagement, religiosity, spirituality.
  - Relationships and intimacy (life): attachment anxiety and avoidance, social comparison, forgiveness; sensitive:
    sociosexuality, relationship exclusivity.
  - Everyday and health (life), sensitive: health vigilance, body image, alcohol and substances.
  - Money (work): mental accounting, materialism; sensitive: financial security, attitude to debt.

  Every facet carries the instrument it was modelled on (`Facet.source`), rendered with its poles into
  `docs/ontology/v2.sources.md`. Changes from the M9 plan: `worldview` became `spirituality`, `body_relationship`
  became `body_image`, `substance_moderation` became `substance_use` (clearer names for the same constructs), and
  `scarcity_mindset` was replaced by `materialism`: scarcity is a situational state (Mullainathan & Shafir 2013), not
  a stable trait, and overlaps `financial_security`. Facet groups are per version (`getFacetGroups`), so views follow
  the mimic's ontology.
- **reserve.v2**: reserve.v1, keys unchanged, plus two concrete items for every new facet (68). Sensitive items ask
  one facet directly and plainly, presume nothing, cover the range (including "not religious" or "no alcohol") and
  have no "prefer not to say", because the consent is the opt-out. A config picks its set with the optional
  `reserve.setId`; configs without it keep reserve.v1 and its fixed order. Later sets serve the items whose facets
  have been asked least first, so a stalled generator still spreads questions.
- **gen.v3**: gen.v2's belief-driven targets, plus strict concreteness (one specific everyday situation, options that
  are actions, self-rating forms forbidden by name), everyday scenes for everything outside "Work and money", an even
  quota per category with facets in scope (weighted by need in ADR-0044), and sensitive facets marked in the ontology
  block and listed as askable only when consented.
- **Workplace scenes follow "Work and money"**, for every generator: without that category the professional quota
  is zero, professional drafts are rejected in code, and professional reserve items are skipped.
- **gates.v3** (optional `generator.gates`; gates.v2 when absent, unchanged word for word):
  - `concrete` fails below 0.4 and `demeaning` above 0.5, on every draft.
  - `sensitive` asks only about the areas a draft is not tagged with, and about the answerer's own life. Tags are
    already limited to consented areas (`validateDraft`), so a draft must be tagged with a facet of every sensitive
    area it touches: an untagged or mis-tagged sensitive draft fails. This replaces "skip the gate when consented",
    which would have let a draft tagged `political_leaning` but asking about health through.
  - `leading` judges the wording, not whether one option is more admirable.
  - The sensitive and leading wording changed after the first calibration run: the gates.v2 wording rejected 7 of 59
    gen.v3 drafts for a nurse because caring for patients read as "health", and flagged ordinary moral scenarios
    (returning extra change) as leading. Both rewordings follow label definitions written before the run.
  - `quality_json` gains `sensitiveAsked` (the areas the draft was checked against).
- **Calibration** (`pnpm eval -- gates`, live Jev, `docs/reports/m10-gates.md`) on
  `packages/eval/labeled/gates.v3.json`: 133 items (59 raw gen.v3 drafts and 20 raw gen.v2 drafts sampled with the
  new `pnpm eval -- drafts`, 54 handwritten for the rare classes), labelled by the implementer from written
  definitions.

  | Gate | AUC | Fails when | Caught | False alarms |
  | --- | --- | --- | --- | --- |
  | concrete | 0.990 | p < 0.4 | 33 of 34 | 3 of 99 |
  | sensitive | 0.993 | p > 0.3 | 11 of 11 | 3 of 122 |
  | demeaning | 0.960 | p > 0.5 | 9 of 10 | 4 of 123 |
  | leading | 0.948 | p > 0.4 | 9 of 12 | 4 of 121 |
  | ambiguous | 0.780 | p > 0.9 | 1 of 6 | 0 of 127 |
  | quick | 0.887 | p < 0.6 | 1 of 3 | 2 of 130 |

  `ambiguous` moved from 0.85 to 0.9: it barely separates, and every ambiguous item in the set is abstract, which
  `concrete` catches; at 0.85 it rejected 4 good gen.v3 drafts. `quick` keeps its gates.v2 threshold (3 slow items
  are too few to move it). On a held-out set (`gates.v3.heldout.json`: 40 gen.v3 drafts for an accountant, sampled
  and labelled after the thresholds were fixed), gates.v3 passed 34 of 36 good drafts and rejected 1 of 4 flawed
  ones, whose flaws were mild. By hand, 58 of 59 and 39 of 40 raw gen.v3 drafts were concrete.
- **reflect.v2 and hyp.v2** tell the reflector and the hypothesis writer that a sensitive facet is named only from
  answers to questions that asked about it directly and never inferred; the reflector's facet list marks sensitive
  ids. hyp.v2 is used for configs on ontology v2 and later (derived, no config field). The code guards come in
  ADR-0043.
- **Candidate config.** `cfg.m10.candidate` (eval only, `--config m10-candidate`) is the default (`cfg.default.v6`,
  ADR-0041) on ontology v2 with reserve.v2, gen.v3, gates.v3, reflect.v2 and domain mix core 15 / casual 55 /
  professional 30. The default config is unchanged until ADR-0044. Offline fakes append rogue drafts to every gen.v3 batch (a self-rating, an untagged
  religious question, a political one, a loaded one) so tests show each guard work.
