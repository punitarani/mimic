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
  files to `apps/web/public/autocomplete/`, plus `lib/autocomplete-sources.json`, the attribution the licenses
  require. `/credits` shows it, linked from the footers of `/` and `/new` (invite links land on `/new` directly), so
  the form stays clean. All three are committed and deterministic. The script's directory is its own package, outside
  the workspace. It installs its ~80 MB of source data only when run, so CI and deploys never download it.
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
  have no "prefer not to say" option, because the consent is the opt-out (ADR-0050 later added "Prefer not to say"
  as a button outside the options). A config picks its set with the optional
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

## ADR-0043 — Scope enforcement, direct evidence only, and the consent UI (2026-09-30)

ADR-0040 made a deselected category or an unconsented sensitive area unreachable through the facet list. That left
four ways in: a model inferring a sensitive trait from other answers, the web, cross-person statistics and research
exports. This ADR closes them in code, adds the consent UI, and proves both with leakage tests.

- **Direct evidence only** (`packages/core/src/scope.ts`). The scope view gains `sensitiveFacets` and `areaSeqs`
  (the seqs of answered questions that asked about each area directly).
  - Trait reader: a sensitive facet is sent to Jev only after a question has asked about it; psychometric anchor
    traits are kept only for allowed facets.
  - Reflector (`guardInsight`): an insight keeps a sensitive facet tag only when it cites a direct answer on that
    facet; an insight whose text states a special-category attribute (the lexicon below) without citing a direct
    answer in that area is dropped. Reflection facts (`reflectionFactAllowed`) follow the same rule.
  - Hypotheses (`guardHypothesisText`): a sentence guessing a special-category area is removed unless a direct
    answer in that area exists by the reading's `seqUpTo`.

  Prompts (reflect.v2, hyp.v2) already say this; the guards make it true when a model ignores them. The offline
  fakes now do ignore them (they infer religion from anything), so the tests exercise every guard.
- **Never from the web.** `addFacts` drops search and enrichment facts naming politics, religion, sexuality or
  health (the M9 lexicon, `specialAreaOfFact`) before the store, the graph or the vector index; identity candidates'
  summaries and headlines lose such sentences (`stripSpecialText`) before Jev ranks them or they are stored; carried
  candidate facts are filtered the same way. The Parallel output schema requests no such field, and a contract test
  pins that. The lexicon can miss phrasing; the person reviews every web fact and can remove it.
- **Item statistics.** `runStatsRefresh` counts a row only when the person's current scope still allows its facets
  and, for a special-category facet, the person consented to research use of that area (`researchAllowed`). Money
  follows plain research consent.
- **Research export** (`scrubExport`, before the identity scrub). For each exported mimic, facets it may not share
  (`researchAllowed`) are blocked: questions touching them go with their answers, rewinds, predictions and scores;
  trait rows and history for them go; insights naming them or citing dropped seqs go; reflection facts citing dropped
  seqs or stating a special-category attribute the person didn't share go; graph facet nodes and edges sourced from
  dropped rows go; `mimic_facets` rows go; `why` text loses special-category sentences. `--keep-identity` exports
  skip the scrub (reproduction needs every sealed state), and the CLI warning now says they contain special-category
  answers.
- **Views.** `uiSnapshot`, `mimic.json` and SOUL.md read through the loaders, so hidden answers, traits, insights and
  facts were already gone. The graph now drops what they hide: in `mimic.json` through `scopedKg` (blocked facet
  nodes, edges sourced from hidden facts or insights, orphans), in the session view through ADR-0046's `uiKg`, which
  keeps only edges backed by in-scope facts and insights. Removed-fact lists skip hidden facts, evidence skips hidden questions, and `progress.basics`
  counts only anchors actually seeded. `UiSnapshot.mimic` carries `scope` and `scopeAt`.
- **Replay.** `reproduceOnline` reports primaries served before a narrowing (`scopeAt`) or on a now-hidden question
  as `rescoped`, next to `legacy` and `truncated`, and checks every other state's hash. `report` shows the count.
- **Scope changes** (`PATCH /api/mimics/:id/scope`, body `MimicScope`) call `setScope`, which now also enqueues a
  pool refill, so a widened scope is asked about without waiting for the pool to drain.
- **UI.**
  - Intake: "What to ask about" after the profile fields. Four categories, all on, each with a one-line description;
    each sensitive area nested under its category ("Ask about political views"), off by default, with why we ask
    and the self-only note. An area is disabled, with a line saying why, while its category is off; the last
    category on can't be turned off. With research consent, "Research use of sensitive answers" offers one box per
    consented special area; money follows the research choice.
  - Session: "Topics and consent" in the More menu opens a modal with the same form, "Changes apply from your next
    question", a warning before a narrowing is saved, and Cancel and Save. Focus moves in on open and back to the
    More button on close; Escape cancels. Saving refreshes the snapshot and discards a waiting question that
    became out of scope.
  - Model panel: "Not asked about: …" names the categories that are off.
  - The form's rules live in a pure reducer (`apps/web/lib/scope-form.ts`) mirroring `normalizeScope`, with tests.
    The snapshot cache buster moved to `v2`.
- **Evidence.** `packages/eval/test/leakage.test.ts` (four offline cohorts under `cfg.m10.candidate`: no consents,
  every consent, every consent plus special research consents, and health withdrawn after 12 turns),
  `packages/core/test/guards.test.ts`, `apps/web/lib/scope-form.test.ts`, the adapters contract test, and
  `scripts/browser/scope.mjs` (Playwright against `pnpm dev`, desktop and phone, light and dark; screenshots in
  `docs/screenshots/m11-*.png`). Offline cohorts use fakes and scripted answers: they test mechanisms, not people.

Not done here: the trust ramp (no sensitive question in the first five) and a sweep that reaches every consented
sensitive facet by question 30 are selection changes and come with `cfg.default.v8` (ADR-0044; v7 is the calibrated
primary, ADR-0048).

## ADR-0046 — "Your map" as a knowledge network (2026-09-30)

PLAN §10.1 drew the mini knowledge graph as "you, connected to organizations, places, skills, interests and facets",
with react-force-graph-2d (§10.2). In practice that was a star: `addFacts()` and the reflector write every KG edge
from the person node, so every other node hung off "You"; raw fact strings ("Technologies: Azure, Docker", "Slash —
Software Engineer") were single nodes; a location given twice was two nodes; and labels overlapped on a white canvas
that ignored the theme.

**Decision.** The stored KG is unchanged: it stays evidence-derived and person-anchored (invariant 3). The map is a
view built from it on the client, in three modules under `apps/web/lib/kg`:
- **`build.ts` (data).** Drops the person node (the whole map is the person's). Splits composite labels
  (`clean.ts`: "Company — Role", "Role at Company", headlines, "Label: a, b, c", role lists, dated and aliased
  names), dedupes by a normalized key per kind (places by city, companies by name and alias), gives each node one
  category (Work, Places, Interests, Skills, Traits), and drops fragments that name nothing (over six words, hedged,
  cut off mid-phrase, or a statement). Then infers typed links from what the facts share: role and company named
  together, the current title and employer on one profile, related roles, profile skills and the current role (at
  most six, spread across lists), items of one list or one profile's history, the current employer and home on one
  profile, a school or company named after a place, entities and traits citing the same answers, traits one insight
  names together or whose insights cite the same answers. A link's weight is a confidence no higher than its weaker
  end's. `filterGraph` keeps what meets the threshold (0.5 by default; the slider goes 0.3–0.9), drops isolated
  nodes, and caps any node at 30% of the others, cutting its weakest links first and never a neighbor's only link.
- **`layout.ts`.** d3-force, synchronous and seeded: category anchors around a ring, a weaker pull on nodes whose
  links cross categories (bridges), collision on node and label boxes, the canvas and the controls' corner as bounds.
  Same graph and width, same layout; nothing moves once drawn.
- **`labels.ts`.** Screen-space greedy placement: two nodes per category first, then by importance; below, above,
  right or left; a label that would touch another label, a node or the edge is left for hover or zoom. So labels
  never overlap.
- **Renderer** (`components/kg-graph.tsx`, SVG on the theme's sheet, colors as `--kg-*` tokens: the old hues, lifted
  in dark mode for contrast). Curved thin edges, width and opacity by weight; node size by degree and confidence.
  Hover dims all but the neighborhood and shows description, sources, answer seqs, confidence and links; click or tap
  focuses the neighborhood with the details docked beside it. Drag to pan, drag a dot to move it, pinch or
  Ctrl-scroll or the buttons to zoom, keys when focused. Legend items toggle categories; search rings matches. A
  screen-reader list mirrors the map. react-force-graph-2d is removed.
- **Motion** (PLAN §10.2 animates only the reveal and the fidelity update). The map is drawn settled, with no
  simulation on screen; focus, reset and threshold or category changes ease over about 0.4 s so the person can follow
  where things went, and jump instead under reduced motion.

**Snapshot.** `uiSnapshot().kg` (via `uiKg`) now carries optional provenance: node source, URL and facet ID; edge
source, URL, the answer seqs a fact or insight cites, and an `exhibits` edge's insight ID and text. It also stops
showing what the person took back or the scope hides (ADR-0040): edges whose fact was removed or cites an answer out
of scope, and `exhibits` edges whose insight is superseded or out of scope, are dropped, as are blocked facets and
nodes left without an edge. The 60-node cap keeps the most confident nodes, not the oldest. Older cached snapshots
without the new fields still render. The map's five groups (Work, Places, Interests, Skills, Traits) are kinds of
node for layout and the legend, not the question categories of ADR-0040.

No cross-person data enters the map (invariant 8): every inference uses only this person's facts and insights.

## ADR-0047 — Invite links hide the code field (2026-09-30)

ADR-0026 showed a code from an invite link in a disabled field with a hint. Nothing there is for the person to read
or do, so the field now isn't rendered while the code is locked.

- **Hidden, not disabled.** The code from `?invite=` is still sent with the form and still checked only by
  `POST /api/mimics`.
- **Shown only when the code is the problem.** A 403, or a 400 whose message names `inviteCode`
  (`inviteRejected`, `lib/invite.ts`), shows the field, filled with the linked code, with a hint that it came from
  the link, and focuses it. Any other failure (a 400 about another field, a 429, a server or network error) keeps
  it hidden, so focus isn't pulled away from the error that needs fixing. This narrows ADR-0026's "any failed
  submit unlocks".
- **Prerendered HTML is unchanged.** The Suspense fallback (ADR-0023) still renders the field, since the static page
  can't see the query string; hydration removes it for invite links, so the fields below move up once. Removing
  that shift would mean rendering `/new` per request, which ADR-0023 chose against.

## ADR-0044 — Category balance, the trust ramp, coverage deadlines and `cfg.default.v8` (2026-09-30)

ADR-0042 gave the loop concrete questions and 34 new facets, 11 of them opt-in sensitive, but selection still asked
where the mimic was least sure. With the anchors (seven of ten on psychology) that kept sessions on psychology and
life. On offline sessions under the M10 candidate with every consent, psychology took 50% of the first 30 questions
and work 11%; no person had every facet group touched by question 20, and 20 of 44 consented sensitive facets were
reached by question 30. With psychology off, one of two people was asked a sensitive question among the first five.
This ADR adds balance and ordering to the selector and the generator, and makes the result the default.

- **Selector** (`selector.balance`, `selector.trustRamp`; both optional and undefaulted, so v4–v6 score exactly as
  before and keep their hashes; `docs/SELECTION.md` §5a):
  - The belief gains category shares against an even split over the categories in scope, and facet-group gaps. Only
    categories in scope exist, so nothing pulls toward a category the person turned off.
  - The gap term gives 35% of its weight to the candidate's category shortfall and 25% to its group gap.
  - Once four adaptive questions are answered: a candidate whose categories are all above 40% is skipped unless every
    candidate is (the cap), and while a category is below 60% of its even share (15% with four), candidates in it go
    first (the floor).
  - Coverage deadlines (`balance.groupsBy` 20, `trustRamp.sweepBy` 30): information chooses freely until the facet
    groups still untouched, or the consented sensitive facets still unasked, would no longer fit in the questions left
    (allowing one repeat probe per eight); then only candidates covering one are eligible. This is the shadow-test
    approach to content constraints in CAT (van der Linden & Reese 1998), applied greedily. It was added after the
    first live scripted run: with bonuses alone, live hypothesis information (0 to 1) outweighed the balance terms
    (about 0.1 inside the λ-weighted gap) and the sweep (0.3), so 16 of 20 consented sensitive facets were reached by
    question 30 and each person missed one group by 20.
  - The reserve backs coverage: before each selection the engine adds up to three reserve items for needs the pool has
    nothing for (untouched groups until question 20, unasked consented sensitive facets once the sweep has begun,
    categories below the floor).
  - Trust ramp: nothing touching a sensitive facet is served before six answers, enforced by the engine on the pool
    and the reserve and by the selector with no exception. From ten answers, a candidate touching a consented
    sensitive facet not yet asked about earns +0.3 (the sweep). Sensitive items later in an instrument are answered
    more honestly (Tourangeau & Yan 2007); burden is unchanged, so early questions stay short.
  - Selection diagnostics record `category`, `group` and `sweep`.
- **Generator targets** (`categoryTargets`, `categoryQuota`): eight targets per refill under balance, in three passes:
  untouched facet groups (preferring an unasked consented sensitive facet in the group once the sweep is on), then
  the sweep (least asked areas first), then a category quota weighted `¼ + shortfall` with at least a quarter of the
  targets. The anchors still waiting count as asked and toward the ramp, since they are served first. gen.v3 gets the
  quota and, once the ramp is open, the consented sensitive facets.
- **`cfg.default.v8`** = v7's calibrated primary and shadows (ADR-0048) on ontology v2, reserve.v2, gen.v3, gates.v3,
  reflect.v2, domain mix core 15 /
  casual 55 / professional 30, and `VOI_SELECTOR_V8` (v4 weights plus balance `{ category 0.35, group 0.25, cap 0.4 }`
  and ramp `{ minAnswered 6, sweepFrom 10, sweepBonus 0.3, sweepBy 30 }`, with `groupsBy 20` in balance). v1–v7 hashes stay pinned; `cfg.m10.candidate` is
  built from v6 so it keeps its hash. v7's calibration changes only what is stored (selection runs on Jev's raw scale,
  ADR-0048), so comparing the candidate with v8 still isolates the selector. New mimics get v8; existing mimics keep
  their config.
- **Measurement.** `pnpm eval -- rubric` reports R1 (generated questions passing `concrete`), R2 (category shares by
  question 30, groups by 20), R4 (consented sensitive facets by 30) and R7 (sensitive questions in the first five) per
  population (real, scripted, twin2k) and config, `--arm` per experiment arm. `pnpm eval -- select --series` records
  accuracy on the rest after every pick and questions to sustain 75%; `--categories` simulates a category turned off.
- **Evidence** (`docs/reports/m12-rubric.md`; scripted answers throughout, so these test the mechanism, not people).
  Offline, four people per config with every consent: the M10 candidate kept 0 of 4 within 15–40% per category,
  touched 32 of 40 groups by question 20 and reached 20 of 44 sensitive facets by 30; v8 kept 4 of 4, 40 of 40 and 44
  of 44. Live (real generator, gates and Jev), three sessions per run: without deadlines 25 of 28 groups and 16 of 20
  sensitive facets; with them 28 of 28 and 20 of 20, every generated question concrete, no sensitive question before
  question 11, and `replay --mode online` matching every state. Run c, on the final v8 build, repeated run b: 28 of 28
  groups, 20 of 20 sensitive facets, shares within bounds, first sensitive question at 11.
  Efficiency (R6) needs real answers and is measured by the E3b arm (ADR-0045).

## ADR-0048 — Learnings from the first prod reports: a calibrated primary (`cfg.default.v7`), an honest optimizer verdict, paired comparisons (2026-09-30)

**Evidence.** After ADR-0041 shipped, Actions → Optimize ran twice on prod. The data was 4 consented people and 265
scored questions: 2 dev people and 2 test people. The first run was a GEPA search on Jev's templates. The second was
a free report taken once the `predict.v2` backfill had finished. The numbers are from real people, but with four of
them, a top-1 difference under about 3 points, or a log-loss difference under about 0.03, is noise.

- **Calibration is the one clear win.**
  - At T = 4 the primary's held-out log loss went from 1.804 to 1.124, ECE from 0.267 to 0.098, and item accuracy
    from 57.7% to 57.9%.
  - Over all people, accuracy on score questions went from 73.8% to 74.6%.
  - Both test people improved on their own: 1.61 → 1.03 and 1.96 → 1.20.
  - A refit on four people puts T at 5.3 (test log loss 1.112 against 1.124). That isn't worth a new version.
- **`predict.v2` is a reliability fix, not an accuracy change.** I paired v2 and v1 by hand on the 232 questions of
  the three fully backfilled people:

  | Model | Log loss (v2 vs v1) | Top-1 (v2 vs v1) |
  | --- | --- | --- |
  | DeepSeek | 1.064 vs 1.068 | 50.4% vs 48.7% |
  | MiMo Flash | 1.042 vs 1.053 | 50.0% vs 48.7% |
  | GLM | 1.050 vs 1.049 | 49.1% vs 49.6% |
  | Luna | 1.088 vs 1.091 | 47.0% vs 48.7% |

  Failures across the four fell from 11 to 4.
- **The key enum didn't make GLM slower or DeepSeek costlier.** In the backfill, GLM's p50 went from 1.5 s to 6.5 s
  and DeepSeek's cost per prediction rose 34%. A live probe of 12 calls each, with and without the enum, ruled the
  enum out:
  - GLM took 1.4 s with it and 13.4 s without. Each call went to Wafer or Together, and Wafer was the slow one.
  - DeepSeek went to Wafer every time, at the same cost either way.

  The likely cause is the backfill itself: a burst of about 1,500 calls in random order. Live calls are made one
  question after another on a state that has just grown by one line, so they get prompt-cache hits the backfill
  doesn't. The enum stays on for every model.
- **Reasoning helps Qwen, but Qwen is still the weakest model.** Reasoning on (`predict.v2`) against off
  (`predict.v1-direct`), on the same people:
  - top-1 44.1% vs 41.3%;
  - failures 3% vs 21%;
  - log loss 1.22 vs 1.15. With reasoning on it is overconfident (fitted T ≈ 2.5), and failures scored as uniform
    flatter the reasoning-off arm.
  - twice the cost, and 17.5 s vs 2.8 s.

  MiMo, DeepSeek and GLM beat Qwen on every measure under either setting.
- **The GEPA run's gain didn't replicate.** It cost $1.03 for 30 iterations. Validation improved by 0.052 nats (CI
  0.009 to 0.102). On the holdout the gain was 0.006 (CI −0.012 to 0.023), and item accuracy fell 3.8 points.
  - With two training people split by question, the search fits them. It still printed "Improved", because the old
    rule only required the holdout not to be worse by more than the noise margin.
  - 9 of the 30 iterations were wasted on replies over the 120-word limit, even after the repair turn.
- **Where the mimic learns.**
  - On choice questions, predictors beat the context-only baseline by 6–10 points of top-1.
  - On yes/no questions there is no gain, and several models do worse than the baseline.
  - On scale questions the gain is 1–3 points.
  - People repeat their own answers 84–92% of the time, which bounds accuracy.
- **An unpaired report misleads while a backfill runs.** The first report was taken two minutes into the backfill.
  It compared `predict.v2` on 99–156 early (harder) questions with v1 on all 265, and made v2 look 0.05–0.08 nats
  worse.

**Decisions.**

- **`cfg.default.v7`** is v6 with the primary `jev:typesafe/jev-1.13@jev-predict.v2`, and without the reasoning-off
  Qwen control.
  - *Calibration changes what is stored and shown, not which question is asked.* VOI's information term is the
    mutual information between hypothesis predictions, which T = 4 shrinks about tenfold (0.53 → 0.05 for a clean
    two-way split). Selecting on calibrated predictions would quietly shift selection toward the coverage terms, whose
    weights were tuned on Jev's raw scale.
  - *Stored rows are the calibrated predictor's own output.* The primary, the baseline and the hypothesis rows carry
    `jev:typesafe/jev-1.13@jev-predict.v2` and its prompt version, so a row's ID always says which scale it is on,
    and the baseline's lift compares like with like.
  - *Selection runs on the raw scale.* `selectionView` gives the selector and the hypothesis explorer the same
    templates at T = 1, one Jev call per candidate batch as before. The chosen question's prediction from that call
    is rescaled into the stored primary, so there is no second call.
  - *Everything selection reads from storage goes back to the raw scale.* `rawScale(predictorId, dist)` inverts the
    predictor's registered temperature (`uncalibrate`, exact to the P_FLOOR clip). Three readers use it: the
    hypothesis posterior's likelihoods (`loadHypothesisSet`), the belief state's weakness term (`rawItemAcc`), and
    the cross-person `item_stats` (`runStatsRefresh`), so v6 and v7 people pool on one scale.
  - *Tests pin the invariance.* The same scripted person under v6 and v7 gets identical questions and identical
    selection diagnostics, under both the hypothesis regime and entropy-only selection (k = 0), and v7's stored
    primary, baseline and hypothesis rows are v6's rescaled at T = 4. Calibrating what selection sees, the weakness
    input or the posterior's likelihoods each fails it. A second test checks that `item_stats` from v7 rows equal
    those from v6 rows.
  - *The reasoning-off Qwen control is retired,* since its question is answered. Qwen stays on `predict.v2` like the
    other four; dropping Qwen altogether is a research-scope call left open. Retiring the control saves about
    $0.0004 a question.
  - *T stays 4.*
  - *Numbering.* M12's config becomes `cfg.default.v8` (ADR-0044). The M10 candidate is pinned to v6, so a new
    default changes neither its hash nor what it measures. M13 compares it with v8; since calibration doesn't change
    which questions are asked, that comparison is unaffected by v7.
- **The optimizer's verdict requires replication** (`judge`).
  - "Improved" needs the validation gain above the noise margin with its 90% CI above zero, plus a holdout paired
    gain above zero with 90% confidence on at least 20 holdout questions (`MIN_HOLDOUT`), and holdout item accuracy
    not lower with 90% confidence.
  - A validation gain without that is "Unconfirmed" and gets no suggested version.
  - The holdout section reports the paired accuracy change.
  - A test replays the first run's numbers, and they now come out "Unconfirmed".
- **`optimize.reflect.v2`.**
  - The WORD LIMIT line gives the hard limit, a target 15% below it, and the current text's word count.
  - A reply over the limit gets a repair turn saying how many words to cut.
- **Paired comparisons in the stored report.** For every pair of predictors on the same model (prompt versions,
  calibration, reasoning settings), the report shows the change in log loss and item accuracy with 90% CIs on the
  questions both answered. Versions sort in numeric order (v2 before v10), and a predictor counts once per question.
- **What the stored report treats as the primary.**
  - A primary the LLM fallback served (Jev failed, PLAN §16) is reported under its own role, `fallback`. It is never
    the configured primary's row, never derives a calibrated row, and never enters a pair or a calibration fit.
  - Calibration fits are per primary ID, since a v7 primary is already calibrated and a v6 one is not. A temperature
    fitted on a calibrated predictor is labelled as on top of its own, and log-linear pools are fitted per primary.
  - `diagnose` without `--predictor` reads every primary (each config version's), and a shadow needs `--predictor`.
- **Unchanged:** the key enum, the per-model caps, and the optimizer's budgets.

**Spend.** The backfill cost about $0.85, the optimize run $1.03 and the probes about $0.03: roughly $1.9 of the $5,
plus about $0.70 of earlier smoke tests.

**Next.** The limit is how few real people there are, not the search. Re-run the optimizer once there are six or more
dev people, so the split is by person and validation measures new people.

## ADR-0049 — Intake starts with every topic on (2026-09-30)

ADR-0040 had intake start with the four categories on and the five sensitive areas off, each ticked only by choice.
Intake now starts from `INTAKE_SCOPE` (`packages/core/src/scope.ts`): every category and every sensitive area ticked,
with the copy "Turn off anything you'd rather not share. All topics are enabled by default."

- **Only the form's starting point changes.** Each area still has its own checkbox, reason and self-only note, and
  the person can turn any of it off at intake or later from the session menu. The sensitive-facet rules in
  `docs/CATEGORIES.md` still hold: only direct questions under a given consent populate a sensitive facet.
- **Absent still means no.** `DEFAULT_SCOPE` keeps no sensitive consents, so an API call without a scope and mimics
  created before ADR-0040 are unchanged.
- **Research use stays opt-in.** Special-category answers still leave research exports unless the person ticks each
  area under research consent. Money in detail follows plain research consent, as before, so with money now ticked
  by default, a person who gives research consent shares those answers unless they untick money.
- **Shared form, intake-only line.** The session's Topics and consent dialog reuses the form but not the "enabled by
  default" sentence, which is only true at intake. `scripts/browser/scope.mjs` now checks that every area starts on
  and turns two off by keyboard.
- **Trade-off.** A box left ticked is weaker evidence of consent than one the person ticks; GDPR art. 9 data
  (politics, religion, sexuality, health) generally needs an affirmative act, and the stored scope does not record
  whether a consent was the default or a choice. Sensitive questions also offer no "prefer not to say", on the
  premise that the person chose the area (`gen.v3`, CATEGORIES.md §2), and a default consent weakens that premise.
  Revisit both before an ontology v2 config (or experiment arm) serves sensitive questions, and before opening
  sign-ups beyond invites.
- **Resolved by ADR-0050** before `cfg.default.v8` shipped: special-category areas now need a confirmation beyond
  the pre-ticked box, and sensitive questions offer "Prefer not to say".

## ADR-0050 — Confirmed consent for special categories, and "Prefer not to say" (2026-09-30)

ADR-0049 made intake start with every sensitive area ticked. It flagged two things to settle before an ontology v2
config serves sensitive questions, and `cfg.default.v8` (ADR-0044) is such a config: nothing recorded whether a
consent was the default or the person's choice, and sensitive questions had no "prefer not to say". Both are
resolved here, reusing the scope machinery so enforcement stays in one function, `facetAllowed`.

- **Confirmed consent for special categories.** `MimicScope` gains `confirmed` (`mimics.confirmed_json`, migration
  0008). A facet in a special-category area (politics, religion, sexuality, health; GDPR art. 9) is allowed only
  when its area is both consented and confirmed. An area left pre-ticked is stored as consented but blocked
  everywhere a facet can reach: prompts, targets, the pool, the reserve and serving. Money in detail is not
  special-category data, so its consent alone is enough, as before. `normalizeScope` keeps a confirmation only
  where the consent is on, so withdrawing a consent also withdraws its confirmation. Existing consents read as
  unconfirmed, which is the conservative choice; only ontology v2 configs have special-category facets.
- **What counts as confirming.** Any of these three:
  - Ticking an area yourself, at intake or in Topics and consent (the form tracks it: ticking confirms, unticking
    clears).
  - "Ask me" on the one-time card shown in the session once the trust ramp opens (six answers).
  - "Confirm" next to an area in Topics and consent that says "Not confirmed yet".

  The card lists each unconfirmed area with "Ask me" and "Don't ask", and Continue stays disabled until every area
  is decided. "Don't ask" withdraws the consent. "Not now" keeps the areas unconfirmed, so they are never asked
  about, and the card returns on the next visit. Confirming widens the scope and changes no stored data.
- **"Prefer not to say".** Every served question touching a sensitive facet (money included) carries
  `sensitive: true`, and the session shows a "Prefer not to say" button next to the answer controls.
  `POST /api/mimics/:id/decline { questionId }` (`declineQuestion`) adds the question's sensitive facets to
  `scope.declined` (`mimics.declined_json`). `facetAllowed` blocks declined facets, so:
  - the question is discarded unanswered and nothing is scored;
  - pooled questions on those facets are discarded;
  - those facets are never asked about again.

  The person can undo it in Topics and consent ("You chose not to answer", "Ask again"). Only the current served
  question can be declined; declining it again is a no-op; a question on no sensitive facet is refused with 409.
- **Answer options are unchanged.** "Prefer not to say" sits outside the options, so Jev never predicts it, and
  gen.v3 and reserve.v2 keep their IDs and their "no prefer-not-to-say option" rule.
- **Replay stays exact where it can.** `setScope` now separates two effects of a narrowing:
  - Discarding out-of-scope pooled and waiting questions happens on every narrowing.
  - Stamping `scope_at` (hiding what was learned) happens for a category, consent or confirmation removed, and for
    a declined facet only when an answered question touches it.

  Declining a question nobody has answered on hides nothing, and every sealed state stays hash-checkable. A
  request that omits `confirmed` or `declined` keeps the stored values, so an older client can't clear them.
- **Research exports** read the confirmed and declined columns with the rest of the scope, so the scrub is
  unchanged. The rubric counts a declined sensitive facet as asked (R4), since the person was asked and chose not
  to answer.
- **Evidence.** Offline tests in `packages/eval/test/consent.test.ts`:
  - a person who left every area pre-ticked gets no special-category question over 32 turns, while money questions
    appear, and the generator never lists a special-category facet as askable;
  - confirming politics and health after twelve answers brings questions in those two areas only, and hides
    nothing;
  - declining discards the question and never serves the facet again, and can be undone.

  Scripted sessions stand for people who chose, so `runSession` confirms a script's special consents unless the
  script says otherwise. M12's live runs (all confirmed) are therefore unchanged.
- **Supersedes** the "no prefer not to say (the consent is the opt-out)" rule of ADR-0042 and CATEGORIES.md §2, and
  the two revisit items of ADR-0049.

## ADR-0045 — E3b: M12's selection against v4's, on real people (2026-09-30)

M12 (ADR-0044) showed with scripted people that `cfg.default.v8` asks across every category, reaches every facet
group and every consented sensitive facet, and keeps sensitive questions late. Whether that costs or saves questions
(R6, efficiency) needs real answers. A scripted answerer has no true preferences to predict, and this environment
reaches neither real users nor Twin-2K-500. M13 therefore ships the experiment ready to run, plus a readout that
shows real people only, with intervals.

- **Arms, 1:1 by `hash(mimicId)`.**
  - `v8`: `cfg.default.v8` (`08956a22…`).
  - `control`: `cfg.e3b.control` (`834484a3…`), v8 with the selection it had before M12.

  The control drops ADR-0044's balance: category and group terms, cap, floor, group deadline, category targets and
  quota, and the reserve top-up for groups. It also switches off the sensitive sweep and its deadline (both start at
  question 1000). Everything else is identical: the calibrated primary, ontology v2, reserve.v2, gen.v3, gates.v3,
  reflect.v2, the everyday-first mix, the consent confirmation, "Prefer not to say" and the trust ramp. The arms
  therefore differ only by M12's selection.
  - *Why not the M10 candidate as control.* It is pinned to v6, whose primary is uncalibrated Jev. Fidelity is
    computed from the primary's predictions, so calibration would confound the comparison.
  - *Why keep the ramp in the control.* Holding sensitive questions back is about respect, not efficiency, so it is
    not what E3b tests.
- **Metrics** (PLAN §12.7).
  - Primary: fidelity at 20 answered questions.
  - Secondary: questions until fidelity reaches 0.75 and stays there (`questionsToSustain`), reported as the median
    over the people who got there, with the share who did. This metric is censored by how long people stay, which
    is why it is secondary.
  - R2, R4 and R7 per arm from `rubric --arm`.
- **Readout** (`pnpm eval -- arms --data <export>`, report kind `arms`).
  - Per arm: n, each metric with a 95% percentile bootstrap interval (2,000 resamples, seeded).
  - Every arm against the control, with the difference's interval, each arm resampled on its own.
  - A difference whose interval spans 0 is reported as "not significant", never as a win.
- **Real people only.** Participant populations moved to core (`participants.ts`: real, scripted, twin2k).
  - `labOverview` counts real people only unless asked for `population: 'all'`, so `/lab`'s arm curves and
    predictor metrics never mix in scripted sessions or imported panels. `/lab` says so.
  - `arms` also defaults to real people. With `--population all` it labels the output "not a result".
- **Sample size.** Assume an SD of about 6 questions to sustain, or about 0.10 in fidelity at 20. Detecting a
  3-question or a 0.05 difference, two-sided α 0.05 and power 0.8, needs about 64 people per arm:
  2 · (1.96 + 0.84)² · (σ/δ)² ≈ 63. Both SDs are assumptions: check them at about 20 per arm, and report at the
  planned size rather than stopping on a peek.
- **What it can't show.**
  - Which M12 mechanism helps: it tests the bundle.
  - Anything about people who decline research consent: only consented people count.
  - Anything beyond the session: fidelity predicts the person's own next answers.
  - Better coverage is not better prediction per se. E3b asks whether breadth costs questions, and R2 and R4 already
    show the breadth.
- **Setting it up.** `EXPERIMENT_PRESETS.e3b` and `setupPreset` (`packages/core/src/engine/experiments.ts`) register
  both configs and save a draft experiment, idempotent by name. They never start, stop or change anything.
  - `/lab` lists the preset with "Set up as a draft" (`POST /api/lab/experiments/preset`).
  - Starting the draft is the owner's click. Allocation then applies to new mimics only; an existing mimic never
    changes config.
- **Scripted cohort.** `pnpm eval -- cohort --preset e3b` sets the preset up and starts it in a local database only,
  then runs each persona once in every arm through an internal `arm` option on `createMimic`. The arms therefore see
  the same people. It checks which arm asks what and when; its fidelity is never a result.
- **Evidence** (`docs/reports/m13-e3b.md`): the offline cohort by arm, labelled scripted. For live evidence, M12's
  scripted runs a, b and c (v8) and M10's live runs (the M10 candidate: v4's selection on ontology v2) stand in for
  the pair, so no money is spent on another scripted comparison.


## ADR-0051 — span-01 as a challenger to Jev, behind a Cloudflare Flagship flag registry (2026-09-30)

Respan's `respan/span-01` runs on the same OpenRouter Decisions API as Jev, at $0.02/M input tokens against Jev's
$0.042/M. It is added as a challenger behind the Flagship string flag `decisions-model` (`jev` | `span-01`). At
`jev`, the default, every call runs exactly as before. Runbook: `docs/CHALLENGER.md`.

- **Swappable in the Gateway.** `Gateway.decide` asks a `DecisionRouter` (`decisionChallenger`,
  `packages/core/src/challenger.ts`) which model to use, so no call site changes.
  - It reroutes only requests for the incumbent `typesafe/jev-1.13`, and only for served predictions
    (`CHALLENGER_PURPOSES`).
  - Gates, trait reads and identity stay on Jev, whose probabilities their thresholds were tuned on (ADR-0015,
    ADR-0042).
  - A predictor that names its own model (a shadow, backfill or eval) is never rerouted, because the model is part
    of its stored ID.
- **span-01 is not a drop-in; an adapter makes it one.** Live calls showed limits the model page doesn't state:
  - span-01 takes only a string state and only yes/no (`noul`) questions, and answers anything else with HTTP 400.
  - `planDecision` (`packages/core/src/decision-models.ts`) sends such a model the state as JSON text, and each
    choice option or score level as its own yes/no question. It normalizes the answers into a distribution
    (one-vs-rest) and hands back answers keyed and typed as asked.
  - The trace records the request actually sent (invariant 5), and Jev's requests pass through untouched.
  - One-vs-rest is an approximation and roughly doubles the input tokens, so the benchmark reports quality by
    question type and cost per request.
- **Fallback, logged.** The span-01 call uses the same adapter, timeout and retries as Jev. If it fails (an error, a
  timeout, or a question unanswered or mistyped), the same request goes to Jev. Each attempt is its own
  `model_calls` row, and a budget refusal is not retried. A rejected answer was still billed, so its failed row keeps
  the provider's usage and cost, which count against the budget (`RejectedResponseError`).
- **Versioning (invariant 4).** A rerouted prediction keeps its config's predictor ID. Its `modelSnapshot` names the
  model that answered, so reports split on it.
  - The flag is for the trial and rollout.
  - To make span-01 permanent, ship a config with `jev:respan/span-01-20260925@…` as primary, so predictor IDs and
    config hashes say so.
  - `SPAN_MODEL` pins the dated snapshot. A `decisions-model` value serves only a model registered and pinned in
    `DECISION_MODELS`; anything else leaves Jev in place, so a dashboard edit can't serve an unreviewed model.
  - The option-splitting wording is `NOUL_SPLIT` (`noul-split.v1`), versioned like a prompt, with the recorded
    fixture pinning its text.
  - Flags that hold for the whole environment (budgets, providers) are evaluated with one fixed targeting key, so
    every request reads them alike.
- **Flagship over env vars.** Flagship toggles at runtime without a redeploy, rolls out by percentage on a stable key
  (the mimic ID, so each person keeps one model), and rolls back in seconds. Env vars need a Doppler change and a CD
  run for each of those.
  - It was chosen because its setup is one binding with a pinned app ID. It is in public beta, with pricing
    unannounced.
- **One registry, checked.** `FLAG_SPECS` (`packages/core/src/flags.ts`) defines each flag once: key, type, code
  default, the var it overrides, and a parser for the values it accepts. Runtime reads and the checks all use it.
  - **Runtime.** Core sees a `FlagReader`; `packages/db/src/flags.ts` wraps the binding. Every read has a default
    that equals the behaviour before the flag.
  - **`pnpm flags:check`** holds the live app to the registry. It fails on a missing flag, on a default or rule-served
    variation the code can't use, and on a flag that doesn't evaluate through Flagship's evaluate API. It warns about
    flags nothing reads, flags that override their setting, and unusable variations nothing serves yet.
  - **Where it runs:** in the Flags workflow on every PR, every push and daily, and in deploy preflight.
  - **After deploy**, `/api/health` evaluates every flag through the Worker's own binding (reason and error code
    only; the endpoint is public), and the smoke test fails on an error.
  - **Token.** The check needs only Flagship App · Read and Evaluate. The app ID is pinned in `wrangler.jsonc`, so
    the deploy needs no Flagship permission to find it. Preview binds no app.
- **Migrated to flags:** `budget-usd`, `budget-session-share`, `search-provider`, `enrich-provider` and
  `embeddings-provider`, which read Flagship over their vars (`flaggedEnv`).
  - A flag overrides only when its value parses, differs from the var, and names a provider whose key or binding is
    deployed. Otherwise the var stands, and the reason is logged once.
  - Deploy pushes every provider key set in Doppler, so a provider flag can actually switch.
  - The vars stay as the fallback.
- **Left as env vars:** secrets, and infrastructure: `DEV_MODE`, `EGRESS_RELAY` and `VECTOR_BACKEND`.
  `VECTOR_BACKEND` picks which store holds the vectors, and prod's live only in Vectorize, so flipping it at runtime
  would read and write an empty store. The dashboard's `vector-backend` flag is not read, and the check warns about it.
- **Benchmark.** `pnpm eval -- benchmark` (and the Benchmark workflow, after merge) runs the production primary and
  the same predictor on span-01 over the same sealed instances.
  - It reports quality overall and by question type, p50/p95 latency per request, cost per request and error rate,
    as Markdown, CSV and JSON.
  - It applies `DECISION_RULE`: switch only if the paired log-loss interval is below 0, with accuracy no more than
    1 point lower, errors no more than 1 point higher, and latency and cost within 1.5×, on at least 200 predictions
    from at least 5 people.

## ADR-0052 — Flags for runtime levers only; provider choices back to Worker vars (2026-10-01)

ADR-0051 put six settings behind Flagship. Five of them were also Doppler settings and `wrangler.jsonc` vars, so one
value could live in three places, and `flags:check` warned whenever they disagreed. A day in prod showed the cost:
about 5,000 evaluations, mostly the five setting flags read on every request and queue batch, with p90 65 ms. Nobody
changed those values in that time. This ADR gives every value one home, chosen by how it changes.

- **Flagship: runtime levers.** A flag must be worth changing without a deploy (a rollout, a kill switch, a spend
  cap). It must be safe at its default, and its values must need nothing deployed beyond what every value already
  has. Three flags pass:
  - `decisions-model`: rollouts by mimic, and the kill switch back to Jev;
  - `budget-usd` and `budget-session-share`: the spend caps (ADR-0035).
- **Spend caps.** In prod the flag is the only source. The deploy no longer reads `BUDGET_USD` or
  `BUDGET_SESSION_SHARE`, and preflight warns if they are set. Without Flagship (preview, local dev) the caps are
  the code defaults, or those vars in `.dev.vars`.
  - In prod a failed read now falls to the code default ($1) rather than a deployed var.
  - That is the conservative side for a cap: a mimic past $1 is refused until the read works again. It never
    overspends.
  - The deployed var it replaces wasn't the flag's $2 either (preflight reported the flag serving 2 over it), so
    this is no looser than before.
  - Flagship evaluates from the last propagated configuration when its control plane is down, so only a failing
    binding reaches the default.
  - Moving the default itself is a code change to `DEFAULT_BUDGET_USD`, reviewed like any other.
- **Worker vars in `wrangler.jsonc`: deploy-time choices.** `SEARCH_PROVIDER`, `ENRICH_PROVIDER`,
  `EMBEDDINGS_PROVIDER` and `VECTOR_BACKEND` are checked-in settings. Doppler may override one; preflight warns
  when an override equals the checked-in value, so a redundant one can be deleted. They are not flags because:
  - A provider needs its key deployed. As flags, every provider key had to be pushed just in case, and a flag
    naming a provider without one was skipped at runtime.
  - Parallel enrichment also changes which queue runs the job (ADR-0034).
  - The vector backend is infrastructure (ADR-0051).
  - Removed with the provider flags: dashboard-label parsing, the key-presence checks, pushing unused provider
    keys, and comparing flags with settings in `flags:check`.
- **Prod behaviour is unchanged.**
  - Prod's embeddings were served from OpenRouter by both the flag and Doppler, so `EMBEDDINGS_PROVIDER` for prod
    is now `openrouter` in `wrangler.jsonc`.
  - Search and enrichment stay Exa.
  - The `budget-usd` flag's $2 still applies.
- **Retiring the dashboard flags.** `search-provider`, `enrich-provider`, `embeddings-provider` and `vector-backend`
  are warnings in `flags:check` (no code reads them), never failures. They can be deleted once this deploy is live.
- **Leftover provider keys.** `wrangler deploy --secrets-file` adds secrets and never deletes them, so a key that
  ADR-0051 pushed for a provider not chosen (`PARALLEL_API_KEY`, `PERPLEXITY_API_KEY`) stays on the worker, and is
  no longer rotated with Doppler. Delete each with `wrangler secret delete <NAME> --env prod` from `apps/worker`.

## ADR-0053 — E6: what the mimic learns from, before E3b (2026-10-01)

**Evidence.** The stored-predictions report of 2026-09-30 (6 consented people, 330 questions) shows the primary
barely beating its own context-only baseline. Raw Jev gained +1.0 points of item accuracy (215 questions); calibrated
Jev as served under v7 and v8 lost 4.7 (115 questions; −10.5 on choice questions). Every LLM shadow beat the same
baseline by 2–7 points. A log-linear pool fitted against each of the ten LLM shadows put a weight of 0.000 on Jev.
Fidelity was 69.9% at 20 questions and 63.6% at the end. The digital-twin literature finds the same pattern
(docs/EVIDENCE.md §1): individual accuracy from rich profiles is often no better than demographics alone, while
correlation across people improves.

**Decision.** Run E6 before E3b.
- **Why before E3b.** E3b's metric is the primary's fidelity, and selection pays off only through a predictor that
  uses the answers. E3b also needs about 128 people; E6 needs none, because it reuses the sealed states already
  stored.
- **Design: within-person and paired.** Every arm predicts the same sealed questions from one view of the same state.
  - `viewState` (`packages/core/src/state-builder.ts`) gives the views `context`, `full`, `answers`, `derived` and
    `relevant`.
  - A view is a subset of the sealed state, so sealing holds by construction. `context` has exactly the stored
    baseline's state hash.
  - Jev (the production primary) gets all five views, and DeepSeek V4.1 Flash `predict.v2` gets `context`, `full`
    and `answers`.
  - Data: served questions as served, plus Twin-2K-500 at k = 10, 30 and 100.
  - One question per Jev request in every arm (`maxQuestionsPerRequest`), so no arm differs by batch.
- **Rule fixed before the run** (`EVIDENCE_RULE`).
  - A view replaces `full` only if, on served questions, its Δ log loss interval is below 0, at least two-thirds of
    people improve and item accuracy drops by at most 1 point, on at least 200 questions from 5 people. Where Twin can
    test the view (`relevant`), its log-loss interval by person must also be below 0.
  - Otherwise the outcome names the bottleneck: the primary learns (start E3b), the model (E7: an LLM or pooled
    primary), the questions, or nothing (check the harness). An outcome that rules a predictor out needs it measured
    with the same minimum data; one cut short by the spend cap or not run is `insufficient`, not "doesn't learn".
- **Reported beside the rule.**
  - Reproduction checks: state-hash match and top-pick agreement with the stored baseline and primary.
  - Lift by answers in the state (dose and response).
  - Across-person correlation and dispersion.
  - Cost and latency.
- **Runs from Actions → Evidence** (`.github/workflows/evidence.yml`, `pnpm eval -- evidence`).
  - It runs on `main` with the production environment, capped at `max_usd`, and publishes to /lab.
  - Cells run in priority order, so a spend cap cuts the least important first.
  - Only aggregates leave the runner.
- **Unchanged.** No config, prompt version, prediction or stored row changes. A `ship` outcome adds a `stateView`
  harness setting and a new Jev prompt version, backfilled as a shadow before any config uses it.
- **E3b stays a draft** until E6's verdict is `learns`, or a shipped view makes it so.

**Spend so far.** A live smoke on one scripted person: $0.011. The full run is expected to cost about $2.

**Result (2026-10-01; `docs/reports/e6-evidence.md`).** Run `01M3TJAEA5H0GB75D8Z11Q4MMA`: 6 served people (330
questions) and 100 Twin-2K-500 people, $2.07. Verdict: `questions`.
- On served questions neither model learns. Jev's `full` − `context` log loss was −0.024 [−0.065, +0.019], and
  DeepSeek's +0.024 [−0.032, +0.081].
- On Twin both learn. At k = 30, Jev's change was −0.039 [−0.058, −0.021] and DeepSeek's −0.056 [−0.097, −0.013].
  Jev's accuracy gain grows from −0.2 points at k = 10 to +6.2 at k = 100.
- No view replaced `full`.
- DeepSeek's context-only prior already beats every Jev view on served questions, so the LLM shadows' lift in /lab
  was mostly a better prior (exploratory).
- The state-hash reproduction check needs a `--keep-identity` export; the workflow's scrubbed export can't match, and
  top-pick agreement (89% against the baseline, 95% against the primary) stands in for it.
- **Decision:** E3b stays a draft. Next is a held-out probe set (proposed as E7), so learning is measured apart from
  what selection asks next, then selection that also exploits.


## ADR-0054 — `decision:` predictor IDs, and rerouted predictions stored under the model that answered (2026-10-01)

A predictor ID's prefix names how the predictor is called, not a model: `llm:` is a chat completion that returns JSON
probabilities, and `jev:` was the OpenRouter Decisions API (a state plus typed questions, answered with
probabilities). With span-01 on the same API (ADR-0051), `jev:respan/span-01-…` misread, and a third model would have
read worse. Separately, a served prediction the `decisions-model` flag rerouted to span-01 kept Jev's predictor ID, so
`/lab`, `evaluate --from stored`, calibration fits and paired comparisons pooled the two models. ADR-0051 said reports
split on `modelSnapshot`; none did.

- **`decision:` is the kind.** `PredictorKind = 'decision' | 'llm'`; `JevPredictor` is `DecisionPredictor`. New code
  names and stores decision predictors `decision:<model>[@<version>]` (`formatPredictorId`).
  - **`jev:` is a permanent alias.** `parsePredictorId` reads it as `decision:`. Configs v3–v8 and `cfg.e3b.control`
    spell their primary `jev:…`; configs are immutable and their hashes pinned, so they keep it, and a config
    registered later may use either spelling.
  - **Not renamed:** the prompt IDs `jev-predict.v*` (their templates were written for and tuned on Jev) and the
    components `jev.*`, the harness field `jevState` (it is hashed), the trait method `jev` and `traitReader.type`
    (a DB enum and hashed configs), the flag variant `jev` (it names a model), `JEV_MODEL`, `jevKey` and
    `jevRequests` (Jev's 32K batching).
- **One spelling wherever an ID is compared.** The Store reads and writes predictor IDs canonically
  (`canonicalPredictorId`, a pure prefix swap), so every reader, D1 or an eval export, sees `decision:`, and nothing
  new is written as `jev:`. IDs that don't come from the Store (configs, job payloads, CLI flags) are canonicalized
  where they are compared: `runShadow`, `missingPredictions`, `shadowJobs`, backfill runs, `diagnose`, the benchmark,
  and `pnpm backfill`'s SQL, which matches both spellings (`predictorIdSpellings`).
  - Jobs keep the key they were enqueued under, so a job from before the deploy still closes its own ledger row; its
    handler runs it as `decision:`.
- **Hashes unchanged.** `promptHash` hashes the decision kind as `jev`, so optimizer candidates keep their
  `cand-<hash>` labels and the eval caches stay valid; a GEPA `state.json` from before is upgraded on resume. Every
  config hash is unchanged (pinned in `math.test.ts`); prompt hashes and candidate hashes are now pinned too.
- **Rerouted rows name the model that answered.** `Gateway.decide` returns the model it ran on (`model`, beside the
  dated `modelSnapshot`), and `DecisionPredictor` sets `servedModel` on a result another model answered. Primary,
  baseline and hypothesis rows (session and playground) are stored under `servedPredictorId`: the configured ID with
  that model swapped in, keeping the prompt version, for example `decision:respan/span-01-20260925@jev-predict.v2`.
  Role, config hash and prompt version are the config's.
  - A span-01 failure falls back to Jev and keeps Jev's ID; both failing keeps the configured ID; the LLM fallback is
    unchanged (`llm:…`, `fallback`). Shadows and backfills are never rerouted, so they never set it.
  - So `/lab`, the stored report, fits and paired comparisons list span-01 apart, under the ID the benchmark uses
    (`CHALLENGER`); `reproduce` re-predicts a rerouted row on span-01; and a Jev backfill now fills the questions
    span-01 served (none of their rows is Jev's), which is how the two compare on the same questions.
- **Stored rows are relabelled after the deploy, not by a migration.** Migrations run before the new code ships
  (`scripts/deploy/deploy.mjs`) and the old code can't parse `decision:`. `pnpm relabel:predictors`
  (`scripts/relabel-predictors.mjs`; Actions → Relabel predictors for prod) is a dry run unless `--yes`, and safe to
  re-run:
  1. a shadow stored under both spellings for one question (old and new code storing it at once) keeps its better row
     by migration 0006's rule and loses the other with its score, since the unique shadow index would refuse step 2;
  2. `jev:` becomes `decision:` on every prediction row, in batches until a recount reaches 0;
  3. served rows under Jev's ID whose snapshot names a challenger pinned in `DECISION_MODELS` take its ID. Any other
     snapshot is listed, not changed.
  - `--reverse` renames `decision:` back to `jev:`, for a code rollback; step 3 stays, since the old code reads
    `jev:respan/span-01-…@…` as a span-01 prediction, which it was.
  - Configs, job keys, eval reports (`eval_runs`) and `model_calls` are records of what ran, and are left alone.
  - Runbook: `docs/DEPLOY.md`. Until it has run, the code reads both spellings, so nothing depends on its timing.
- **No new config.** Existing mimics keep their config either way; a new config only for the spelling would split the
  primary's history at an arbitrary point. The next config made for another reason uses `decision:`.
- **Evidence.** `served-model.test.ts` (sessions with the flag off, on, span-01 failing and both failing; the
  playground; `/lab` and the stored report), `relabel-predictors.test.ts` (pre-ADR-0054 rows relabelled to exactly
  what the new code stores, idempotent, reversible), the mixed-spelling cases in `backfill.test.ts`, and the alias,
  hash and served-ID cases in `components.test.ts`, `math.test.ts` and `challenger.test.ts`. A local run through
  wrangler relabelled seeded rows as expected.
- **Supersedes** ADR-0051's "A rerouted prediction keeps its config's predictor ID. Its `modelSnapshot` names the model
  that answered, so reports split on it", and its `jev:respan/span-01-20260925@…` example: to make span-01 permanent,
  ship a config with `decision:respan/span-01-20260925@jev-predict.v2` as primary.

## ADR-0055 — The invite code behind the `use-invite-code` flag (2026-10-01)

Sign-up has needed an invite code since the start (PLAN §11, ADR-0026). Opening it up, or closing it again, meant a
code change. The gate is now a runtime lever, which is what flags are for (ADR-0052): a kill switch that is safe at
its default and needs nothing extra deployed.

- **The flag.** `use-invite-code` is a boolean, `on` by default, which is the behaviour from before the flag. The
  registry gains a `boolean` kind for it. A string flag with on/off values (`on`, `off`, `true`, `false` and the
  like, as `coerceFlag` reads them) works too; anything else falls back to on.
- **One value for the environment.** It is read with the fixed targeting key `environment`, like the spend caps,
  so the form and the server agree for every person. Unbound (preview, local dev) or unreadable, it is on.
- **Server.** `POST /api/mimics` checks the code against `INVITE_CODES` only while the flag is on. Off, the code is
  optional and ignored. `INVITE_CODES` stays a required secret, so the gate can be turned back on at any time.
- **Form.** `/new` stays prerendered (ADR-0023). It asks `GET /api/invite` whether a code is needed and starts by
  assuming one is, so the field shows as before until the server says otherwise. When the flag is off, the field
  disappears and the code isn't required. A rejected code brings the field back, so a flag turned on while the form
  is open still works.
## ADR-0056 — Evidence policies and the card state (2026-10-01)

The state builder kept answers by recency, similarity and anchor status once evidence outgrew the budget (PLAN §9.9),
which measures nothing about *which* answers carry a person. Two findings say the question matters: twins reproduce
item means and barely the person-specific residual (arXiv 2608.29455: 3% of respondent-specific variance explained,
against 54% for test-retest), and a few thousand tokens of the right structure match a 128K transcript
(arXiv 2608.20344). So the builder now takes an evidence policy, and a compact strategy for transfer and compression
experiments.

- **Policies** (`stateBuilder.evidencePolicy`, optional and undefaulted, so every existing hash holds): `mixed` (the
  incumbent), `recent`, `similar`, `surprise` and `novelty`. `surprise` keeps the answers the context-only baseline
  predicted worst (its log loss over log|options|): what the profile alone gets wrong about the person, the residual
  from the stereotype. `novelty` keeps the answers the sealed primary predicted worst at the time: what the earlier
  answers did not already imply, the MDL view of new information. Both signals are frozen with the answer (its
  scores are written in the same transaction and removed with it on an undo), so inclusion never oscillates and a
  state rebuilds exactly from an export. A calibrated primary is read on its raw scale (`rawScale`, ADR-0048).
- **Cap** (`stateBuilder.maxEvidence`) bounds the answers in a state whatever the budget; the policy fill also counts
  the evidence key itself, so the budget holds exactly.
- **`card`** (`stateBuilder.strategy`): identity, traits and the capped answers, no insights. It is the state that
  fits a few hundred tokens, for the transfer eval (ADR-0057) and for shadows that test how small a state can be.
- **Replay** takes `--evidence`, `--max-evidence` and `--budget` overrides, computes a baseline surprise for imported
  answers that have none (sealed by construction), and counts a policy-trimmed state as checkable in
  `replay --mode online`: only `mixed` and `similar` rank against the candidate pool, which an export does not hold.
- **Online**, the loaders fetch the stored scores only for a config whose policy reads them (`needsScores`), so the
  serve path of every current config makes no extra query.
- **Not done:** marking surprising answers in the state text (a hint like `pace`), and the replay on real people that
  decides whether `surprise` or `novelty` beats `mixed` at equal tokens (docs/RESEARCH.md §6).

**Result (2026-10-01; `docs/reports/twin-benchmark.md`).** On 60 imported Twin-2K-500 people, raw Jev, 3,932 sealed
held-out predictions per cell, two passes: a 12-answer card is level with the served state after 30 answers
(+0.6 [−0.7, +2.0] points, intervals over people) at 48% of its tokens, and −1.0 [−1.7, −0.3] after 100, where the
served state is itself the §9.9 subset of 18 answers. `mixed`, `recent` and `similar` sit within the run-to-run noise
of each other (0.25 points on average between passes), because replay built one state per person with no target to
retrieve for, so similarity fell back to recency; ADR-0064 measures retrieval per target. `surprise` costs −1.1
[−2.0, −0.4] points at k = 100 and improves raw log loss by −0.088 [−0.120, −0.056]; with the calibrated primary and
surprise ranked on the raw scale that gain shrinks to −0.010 [−0.016, −0.004], and it is a loss at k = 30. Every
12-answer card halves dispersion across people at equal accuracy.

## ADR-0057 — Transfer loss: an agent reading only the export (2026-10-01)

ADR-0039 left "test my SOUL.md" for later. Products that load a person model truncate or re-extract it (OpenClaw caps
a bootstrap file at 20,000 characters, Hermes keeps USER.md to 1,375, claude.ai re-extracts imports into entries), and
no product or paper reports what a person model loses when it moves. `pnpm eval -- transfer` measures it.

- For every person and checkpoint *k*, each view is rendered from the first *k* answers alone, with derived data as
  of the serve time, exactly as replay builds states: `context` (identity only, the baseline), `state` (the full
  state the mimic uses, the reference), `card` (ADR-0056), `soul-core`, `soul-full` and `mimic-json`.
- A **reader** that knows nothing about Mimic predicts the later (or held-out) answers from the view and nothing
  else. An LLM reader uses `transfer.v1`: third-person prediction (arXiv 2607.24782), the file first and the question
  last so one file serves many questions from a prompt cache. A Jev reader gets the file as its whole state.
- **Transfer loss** is the `state` view's accuracy with the same reader minus the view's, beside each view's size in
  tokens, log loss, Brier, ECE, lift over `context`, cost and latency. The frontier of accuracy against tokens per
  format is the deliverable.
- **Drafts.** `--draft` writes a sealed `soul.v1` draft per person and checkpoint (one LLM call each); otherwise a
  stored draft counts only when its `seqUpTo` is below the checkpoint.
- **The eval checks its own sealing:** a rendered view that contains a later question's prompt, or a later reason,
  stops the run.
- Scripted sessions prove the machinery only; the numbers that matter come from the consented cohort
  (docs/RESEARCH.md §3).

**Result (2026-10-01; `docs/reports/twin-benchmark.md`).** A DeepSeek V4.1 Flash reader on 10 imported Twin-2K-500
people at k = 30 (200 targets): 59.4% from the state text, 54.2% from the card, 53.7% from `mimic.json`, 53.4% from
the full SOUL.md, 49.2% from the core SOUL.md and 48.3% from identity alone. The core profile without answers is worth
about one point over nothing; the full SOUL.md carries the same answers as the state at twice the size and still
loses six points. The first Jev run died on one draft timeout, so the eval now counts a failed draft and goes on
without that person's narrative; the Jev table is in the report.

## ADR-0058 — Ensembles of what is already stored (2026-10-01)

Every served question carries the primary and five shadow predictions of the same sealed state (PLAN §9.6), so
pooling them costs nothing new. `calibrationFits` already fits a fixed pool of the primary with each shadow on dev
people; `pnpm eval -- ensemble` adds what is honest per person without fitting anything:

- `log-pool` and `linear-pool` at equal weight; `hedge:η` and `hedge-log:η`, exponential weights from each member's
  cumulative log loss on the person's *earlier* questions (η = 1 is Bayesian model averaging), so the weight for
  question *t* depends on nothing after *t* − 1; an `oracle` that picks the best single member per person in
  hindsight, reported as a bound and never as a result; `--with-baseline` adds the context-only prediction as a member,
  which then acts as shrinkage toward the profile.
- Every method is paired against the primary on the same questions with 90% bootstrap intervals, and the mean final
  weights say which models a person's record ends up trusting.
- `replay --views raw,structured,summary` is the **evidence-view ensemble**: the same predictor on several views of
  the same sealed evidence, pooled log-linearly, the cheap way to get the informational diversity that pooling
  different models on one state lacks (InfoDelphi, arXiv 2607.01661). On Jev it costs a few extra input-priced calls.
- Not done: a served ensemble predictor. A pool that wins offline ships as a registered variant and a shadow first
  (ADR-0024).

## ADR-0059 — A population from the cohort: copula, exemplars, realism (2026-10-01)

Simulation engines take personas as text and a handful of fields (Concordia's `basic__Entity` and formative
memories, Smallville's `scratch.json`, Sotopia's `AgentProfile`), and populations are filled from demographics by a
chat model, which flattens them: one persona gives the same answer on more than half of OpinionQA's items
(arXiv 2607.25292), simulated panels show 0% of what 22% of real respondents report (arXiv 2609.07305). Mimic holds
something those pipelines lack: real people's sealed answers. `pnpm eval -- population` builds from them.

- **Anchor and fill.** A Gaussian copula over the cohort's facet means (`packages/core/src/synth.ts`): each person's
  vector is mapped to normal scores by rank, the correlation matrix is shrunk toward independence with weight
  *n* / (*n* + κ), and sampled vectors return through the empirical marginals. A small cohort exports its marginals
  and only as much structure as it supports. `--norms` for a published prior is left for later.
- **Answers by exemplar.** Each agent answers the cohort's stable items (anchors, reserve) by drawing from the answer
  frequencies of its *k* nearest real people, shrunk toward the population's: a mixture of people, never a copy. It
  draws from stated distributions, the one thing silicon sampling must do (arXiv 2411.05403).
- **Realism against the cohort:** dispersion ratio and caricature per facet, correlation-structure distance,
  coverage (the share of real people with an agent at least as close as their nearest real neighbour),
  re-identification (the share with an agent within half that distance: a near-copy), and the cross-validated R² of
  each sensitive facet from the non-sensitive ones, real vs synthetic, so a population never leaks more than its source.
- **Renderings.** Each agent carries Concordia `basic__Entity` params and a memory bank of plain-text rows, and
  Smallville scratch fields, written from numbers and answers only; the items form a `QuestionnaireBase` for scoring
  agents inside a simulation. `mimic-population/1` carries provenance (people, split, seed, shrinkage).
- **Privacy.** Consented, real people only by default; no names, facts, reasons or ids leave; facets and items below
  `--min-people` (5) are never modelled, as `item_stats` does (PLAN §12.6a).
- Not done: raking to external marginals, a trained twin per agent, and the in-simulation prequential check
  (docs/RESEARCH.md §5).

## ADR-0060 — The observation ledger: how other agents update a mimic (2026-10-01)

A person model other agents cannot update goes stale the day it is exported. The memory systems those agents use
rewrite in place: repeated consolidation turns useful memories faulty (arXiv 2605.12978, 100% to 52.6% after ten
rewrites), consolidation erases who said what (arXiv 2608.01679), and revoked facts keep reaching agents in 43% of
trials across five memory stores (arXiv 2609.08258). Mimic's rules point the other way: evidence is the source of
truth and everything else is re-derived (PLAN §3.3). So the one thing another agent may write is evidence.

- **`mimic-observations/1`**: a batch under a writer's name, of typed observations (question, options, answer, why,
  context, when, authority `stated` or `observed`). `POST /api/mimics/:id/observations` validates each on its own
  (the taught-answer shape; no special-category content by either lexicon; ids unique per writer and mimic, so a
  re-sent batch changes nothing; at most 100 per batch, within a Worker's D1 query limit) and stores it through the
  feedback path (ADR-0032) with `observation:<agent>` as the generator and
  the observation's metadata on the question. The mimic then learns from it as from any taught answer; traits,
  insights and the portrait re-derive from the record, never from an agent's edit.
- **Provenance travels.** `mimic.json` evidence carries `source` (`session`, `person`, `agent`) and the agent;
  SOUL.md marks what an agent observed, so a reader can weigh it below what the person said to Mimic; `GET
  /observations` lists what agents appended, and the record's undo covers it.
- **Refused:** anything that is not an observation (no edits to traits, insights, facts or the portrait), and any
  observation touching politics, religion, sexuality or health, since only a direct, consented question may populate
  those (ADR-0040) and an agent's observation is neither.
- **Not done:** API tokens for agents (today the person's session authorises the write), an MCP server exposing
  `append_observation` and `get_view`, and host-sized views (docs/RESEARCH.md §3).

## ADR-0061 — Footprint: verify by asking, never infer (2026-10-01)

Text predicts a person's traits at about *r* = 0.3 to 0.4 whatever the model (Park et al. 2015; Peters & Matz 2024),
and a model shown someone's posts infers their location, income and worse at 85% top-1 (Staab et al., ICLR 2024).
Twenty years of that ceiling say a footprint can replace some questions, not most, and that a footprint fed straight
into a state is the shortest route to the stereotyped, hyper-rational twin (arXiv 2509.19088). So a footprint never
becomes evidence. It proposes questions.

- **Parsers** (`@mimic/core/footprint`, client-safe): an X archive's `tweets.js`, LinkedIn's Profile, Positions,
  Education, Skills and Shares CSVs, Reddit's posts and comments, GitHub's user and repositories, and pasted notes.
  Only the person's own words (retweets, forks, shares without commentary and quoted replies are dropped); handles,
  links, emails and numbers are scrubbed; a document that touches a special-category area is dropped whole. Content
  hashes make the ids stable. A browser can parse an archive without uploading it.
- **Proposals.** `footprint.v1` reads the documents once (most recent first, within a budget) and writes questions
  whose answers they imply, each citing documents and carrying a confidence. Items are checked like generated
  questions (schema, scope, the quality gates, deduplication), pooled as ordinary adaptive questions with the implied
  answer stored beside them, and never on a sensitive facet.
- **Scoring the footprint.** When the session serves such a question, the implied answer is written as a prediction
  of its own (`footprint:v1`, role `shadow`, no state, sealed trivially), so the person's real answer scores the
  footprint like any model, per source, with the usual metrics; `/lab` and `evaluate --from stored` list it as a
  predictor. This is the number no footprint paper reports: how often the record was right about the person.
- **Spend.** Proposals and their gates are page work (`footprint.propose`, `footprint.gate` draw on the page's
  reserve, ADR-0035), like asking, teaching and SOUL.md: a footprint is offered from the mimic page, never by the
  session.
- **Not done:** a selection bonus where the footprint and the baseline disagree, a verification budget that lets a
  trusted source skip facets, and the retrieval-versus-generalisation split (docs/RESEARCH.md §4).

## ADR-0062 — E7: a held-out probe set, and transfer distance as the yardstick (2026-10-01)

**Context.** E6 returned `questions` (ADR-0053): predictors learn from Twin-2K-500's survey answers and not
measurably from Mimic's served ones. The Twin benchmark (`docs/reports/twin-benchmark.md`) then showed what each
side measures. On Twin, no held-out domain appears in the first 100 answers; the lift is transfer from demographics
and personality scales to product choices (96% of it at k = 100 in 61% of the items), and party and ideology carry
the policy items only while the state still holds them. Mimic's intake already supplies the demographics, and its
selection makes every served question a far-transfer item. So the two datasets measure different distances, neither
measures near transfer, and nothing measures the whole curve on one person. Next-question fidelity cannot be E3b's
yardstick (ADR-0053's result), and no replacement existed.

**Decision.** Add E7 to PLAN §12.7 and run it before E3b: a fixed, versioned probe bank (`probe.v1`) served to
everyone at fixed positions (after 0, 10, 20 and 30 adaptive answers), fourteen items per person at four distances
(a repeat, the same decision template, the same facet, an uncovered facet) plus three shared items with public item
means, each predicted from the sealed state before it is shown and scored like any question. `PROBE_RULE` is fixed
before the first readout. Design: `docs/PROBE.md`. Probes are a new question kind (`probe`), never selected or
generated, behind the `probe-set` flag. The agenda (`docs/RESEARCH.md` §10) reorders around it: measurement first,
then retrieval by meaning and compaction, then selection. Three cheap fixes go with it: a calibration temperature by
evidence count, an evidence-only hash for the reproduction check, and state-insensitive items reported apart.

**Consequences.** Fourteen more questions per session (about four minutes) and no new model spend. Learning is
reported per distance, with a per-person ceiling from the repeats and individuation on shared items from the first
person. E3b starts when the T2+T3 lift at 30 answers gives it a detectable effect with 64 people per arm, and not
before. Twin stays a benchmark for ranking states, policies and readers on the same predictor and questions; it is
not read as evidence about Mimic's people.

**Implementation (2026-10-01).** Built as `cfg.e7.probes` (cfg.default.v8 plus `probes: probe.v1`, session target 44,
budget $0.75) and the `e7` preset in `/lab`, read with `pnpm eval -- probes` (no model calls). Four departures from
the design, each in `docs/PROBE.md` §9: no flag, because flags are runtime levers only (ADR-0052) and the probes are
part of what a person is asked, so they belong in the versioned config; no new question kind, because a probe as an
`adaptive` question marked by its generator goes through sealing, shadows, scoring, exports and undo unchanged; the
bank is the reserve set and the shared items are three reserve items, with item means from the cohort; and distance is
measured when a probe is served (answers on its facets: near, mid, far) instead of from a template map. The clock
counts every other session answer, so the last slot opens where a v8 session ends. Scripted cohorts check the
machinery (`packages/eval/test/probes.test.ts`); nothing has run on people.

## ADR-0063 — An evidence hash beside the state hash (2026-10-01)

**Context.** E6's reproduction check compares the state hash of a rebuilt state with the stored prediction's. The
Evidence workflow runs on a scrubbed export (ADR-0018), whose identity is rewritten, so no state can match there and the
check read 0% while nothing was wrong (`docs/reports/e6-evidence.md`). Which answers a state held is what sealing and
the evidence policies decide, and the scrub does not touch answers.

**Decision.** Every state carries `meta.evidenceHash = sha256(canonicalJson(evidence))`, and every prediction stores it
in a new nullable column, `predictions.evidence_hash` (migration 0009). A shadow on a state stored before this hashes
that state's own evidence. E6 reports, beside the state and top-pick checks, the share of `full` arm rows whose evidence
matches the stored primary's. `stateHash` is unchanged, so no config, state or stored hash moves.

**Consequences.** One more column per prediction row; rows written before it have none and are left out of the check.
The workflow's reproduction check becomes meaningful on every run without `--keep-identity`.

## ADR-0064 — Retrieval per target, and a `fill` policy that spends the budget (2026-10-01)

**Context.** The Twin benchmark's `similar` arms measured recency: replay built one state per person, with no target
to rank against. And at 100 answers the served recipe (`mixed`: anchors, the 6 latest answers, the 12 nearest to the
batch) keeps 18 answers in about 1,400 of the 8,000 tokens §9.9 allows, so the budget is a ceiling it never reaches.

**Decision.**

- `replay --per-target` builds one sealed state per target question with that question as the retrieval target, as
  production does for a batch. `--embed` ranks by embeddings computed once per run through the gateway (purpose
  `eval.replay.embed`), since exports carry no vectors; without it, ranking is by word overlap. `--max-targets` caps
  the targets per person, seeded.
- A new evidence policy, `fill` (`stateBuilder.evidencePolicy`): `mixed`'s picks first, in its trimming order, then
  every other answer by recency until the budget is spent. It ranks by similarity, so production loads embeddings for
  it as it does for `mixed` (`ranksBySimilarity`). No config uses it yet; the enum grew, so no existing hash moves.
- `transfer` accepts a calibration-only decision variant as reader (`@jev-predict.v2`), so transfer loss can be read
  on the served scale.

**Result** (60 Twin people, calibrated primary, 20 targets each, `docs/reports/twin-benchmark.md`). At 100 answers,
embeddings lift policy items from +1.6 to +4.4 points (word overlap +2.5); filling the budget by recency lifts product
items (+9.8 against +8.7); `fill` with embeddings gets both: 67.8% accuracy and 0.814 log loss, +2.7 [+0.8, +4.6] points
and −0.053 [−0.082, −0.024] over the served state, 39 of 60 people better. Batching moves accuracy by under half a
point.

**Consequences.** A filled state costs about five times the primary's input tokens once the budget binds.
Per-target retrieval is an upper bound on retrieval for a batch centroid. Served sessions never reach the budget (up to
about 90 answers fit), so on today's sessions `fill` equals `mixed`: it matters for long-lived mimics and for smaller
budgets such as an agent's card, and a served shadow of it would measure nothing yet (ADR-0065).

## ADR-0065 — View shadows: Jev on derived data, and an LLM's context-only prior (cfg.default.v9) (2026-10-01)

**Context.** E6 left two exploratory leads to test on new people (`docs/reports/e6-evidence.md`): Jev reading only
traits and insights was 4.8 points more accurate than on the whole state, with no log-loss gain, on six people; and
DeepSeek's context-only prior beat every Jev view on served questions. The Twin benchmark points the same way: Jev
reading an LLM's narrative beat Jev reading the answers by 3.6 points with the calibrated reader. On served people the
narrative already exists, as the reflector's insights in the state. A shadow is how a lead becomes evidence (ADR-0024),
but a shadow reads the primary's sealed state, and both leads read part of it. `fill` (ADR-0064) is not a candidate:
served sessions never outgrow the §9.9 budget, so it would equal `mixed`.

**Decision.**

- A registered variant may name a view of the sealed state in its harness (`stateView`: `context`, `answers` or
  `derived`, as E6 defines them). Both predictor classes apply it, so the primary, shadows, backfill, replay and
  evaluate all read the same thing. The option is absent from the incumbent harness, so no prompt hash moves. A
  prediction keeps the sealed state's hash: the view is a function of that state, and the version names it, so the
  "shadow state = primary state" invariant holds.
- Two variants: `jev-derived.v1` (the primary's temperature, derived data) and `predict.v2-context` (`predict.v2`'s
  measured per-model settings, the context alone).
- `cfg.default.v9`: v8 plus `decision:typesafe/jev-1.13@jev-derived.v1` and
  `llm:deepseek/deepseek-v4.1-flash@predict.v2-context` as shadows. Its primary is v8's, spelled `decision:`. E3b stays
  v8 against its control; E7 moves to v9 (`cfg.e7.probes` gets a new hash before anyone joined it), so the view shadows
  are read per probe distance.
- A view is never a calibration: `isCalibrationOnly`, evaluate's free derived calibrations and transfer's readers
  treat a view variant as its own predictor.
- Both run over served questions of consented people with `pnpm backfill` (Actions → Backfill).
- The stored report reads them: every shadow against the primary that served the same questions, across models, with
  intervals over people and this ADR's verdict for view shadows; `--since` keeps people who joined after a date. It
  also gains residual rows (RESEARCH §1.2): each predictor against the population's answers on items asked of at
  least six people, leaving the person's own answer out. That aggregate stays in the report, never in a prompt or a
  state.

**Reading rule, fixed before any data.** On people not in E6's export, paired with the primary on the same questions,
intervals by person (`pnpm eval -- evaluate --from stored`): `jev-derived.v1` is worth a calibrated variant of its own
only if, on at least 25 such people, its item accuracy is higher (90% interval above 0) and its log loss is no worse
(upper bound below +0.01). The context prior is read the same way against the primary; if it wins, the next step is
E6's `model` branch (an LLM or pooled primary within the latency target), not a change to Jev's state.

**Consequences.** Two more shadow rows per scored question: about $0.00001 for Jev and $0.0004 for DeepSeek on a
context-only prompt. New mimics get v9; older ones keep their config and get the shadows by backfill. The leads stay
exploratory until the rule reads them.

## ADR-0066 — Scale questions asked as choices, as a shadow (cfg.default.v10) (2026-10-01)

**Context.** Jev's largest deficit on the Twin benchmark is the five-point policy items, which Mimic asks with the
Decisions API's `score` primitive: log loss 1.45 against 1.37 for the population's item mean, after 30 answers
(`docs/reports/twin-benchmark.md`). RESEARCH §2.3 proposed changing how Jev is asked, not what it reads.

**Decision.** A decision variant may ask scale questions as unordered choices (`harness.scoreAs: 'choice'`): each label
becomes a criterion keyed by its option key, and the answer maps back like any choice. The option is absent from the
incumbent harness, so no prompt hash moves, and the free calibration derivation treats it as another predictor.
`jev-scales.v1` is the primary with that setting and the primary's temperature. `cfg.default.v10` is v9 plus
`decision:typesafe/jev-1.13@jev-scales.v1` as a shadow; E3b stays on v8; E7 moves to v10.

**Result that motivated it** (118 Twin people with policy items, 389 questions, intervals over people): at the
primary's temperature, choices lower log loss on scale questions by −0.059 [−0.084, −0.034] after 30 answers and
−0.082 [−0.111, −0.052] after 100, and raise top-1 accuracy by about 2.6 points. With each format at its own temperature
fitted on dev people (4.07 for the primitive, 3.54 for choices), −0.067 [−0.101, −0.034]. Other question types are
untouched.

**Reading.** On served scale questions, paired with the primary over people (`evaluate --from stored`, "Against the
primary"), on people who joined after this ADR. It replaces the primary only as a calibrated variant of its own, after
at least 25 such people show lower log loss with an upper bound below 0 and accuracy no worse.

**Consequences.** One more Jev call per scored question as a shadow, about $0.00001. Trait estimation keeps the score
primitive (it is not a prediction of an answer).

## ADR-0067 — Research consent covers sensitive answers (2026-10-01)

**Context.** Since ADR-0043, ticking research consent at intake opened "Research use of sensitive answers": one box
per consented special-category area (politics, religion, sexuality, health) and a line saying money follows the
research choice. That made six lines under one checkbox, the longest part of intake, and each box repeated two
choices the person had just made: to be asked about the area, and to share their answers for research.

**Decision.** The research checkbox covers it. Its hint now reads "Only answers from people who check this are used to
compare methods, including answers on the sensitive topics above." The per-area boxes are gone from intake and from
Topics and consent. For someone with research consent, the dialog says instead that the sensitive topics they turn
on there are included.

- **The stored model is unchanged.** `researchConsents` still records research use per area, and `researchAllowed`,
  the export scrub and `item_stats` still read it. What changes is who sets it. `withResearchUse`
  (`packages/core/src/scope.ts`) gives research use to every special-category area the person newly consents to. The
  intake route (`POST /api/mimics`) applies it with no previous scope, so research consent covers every area left
  on. The scope route (`PATCH /api/mimics/:id/scope`) applies it against the stored scope, so an area turned on later
  joins research use. `normalizeScope` still drops all of it without research consent overall.
- **No retroactive widening.** An area already consented keeps the research use stored with it, whatever the
  request sends. People who signed up under the per-area boxes and left one unticked keep that area out of research.
  Only turning the area off, saving, and turning it on again, with the dialog's line in view, includes it; turning it
  off and on before a single save keeps what is stored. Confirming an area in the session and declining a question
  change nothing here.
- **Still an affirmative act.** The research checkbox starts unticked at intake, so special-category answers enter
  research only after the person ticks a box whose hint names them. ADR-0049's trade-off concerns the topic boxes,
  which start ticked, not this one.
- **The engine stores what it is given.** `createMimic` and `setScope` take research use as sent, so scripted
  sessions can still build a person who signed up before this change (`packages/eval/test/leakage.test.ts`).

**Consequences.** Intake is six lines shorter. A new person who gives research consent shares their answers on every
sensitive area they are asked about. Keeping one area out of research while still being asked about it is no longer
possible: the person turns that area off, or leaves research unticked. `scripts/browser/scope.mjs` checks that the
per-area group is gone.

## ADR-0068 — Decision models outside OpenRouter, priced at list rate, and E8 to compare them (2026-10-01)

**Context.** Three decision models arrived that take Jev's request and return Jev's answers: Cloudflare's clef (27B)
and clef-flash (9B), served only by Workers AI, and Perplexity's `pplx-decider-v1-27b`, served only by Perplexity's
API. Mimic reached decision models through one provider, OpenRouter's Decisions API, wired once in `makeProviders`.
Neither new vendor returns a cost: each response carries `usage.input_tokens` and `output_tokens` only. That conflicts
with the rule that money is the provider's `usage.cost` (PLAN §5). Logged at $0, their calls would bypass the budget
guard and every eval's `--max-usd`. Mimic's own Workers AI embeddings already log $0 (ADR-0005), but they are
unmetered infrastructure, not a model under comparison.

**Decision.**
- **One router, three vendors.**
  - `RoutedDecisions` (`packages/adapters/src/decisions.ts`) is the Gateway's decision provider. It sends `cloudflare/`
    models to `WorkersAiDecisions` (REST: `/accounts/{id}/ai/run/@cf/cloudflare/<name>`, since the eval CLI runs in
    Node without the `AI` binding) and `perplexity/` models to `PerplexityDecisions` (`/v1/decisions`). Everything
    else goes to `JevDecisions`, unchanged.
  - The router is always built, so a missing credential fails with the variable's name.
  - `DecisionProvider.providerFor` lets the Gateway log the vendor that served each call.
  - Workers AI calls never go through the local egress relay, which doesn't forward the Cloudflare API.
- **Provider-neutral IDs.** The models are `cloudflare/clef`, `cloudflare/clef-flash` and
  `perplexity/pplx-decider-v1-27b`. `@` separates a predictor's prompt version, so `@cf/…` can't be an ID, and the
  adapter adds it (as `WorkersAiEmbedder` does).
  - They are not flag variants: `DECISION_MODELS` holds only models the flag may serve, and `cloudflare/clef` is a
    prefix of `-flash`, which the relabel forbids there.
  - Neither vendor has a dated snapshot. The recorded snapshot is the model run (`@cf/cloudflare/clef`) or the name the
    decider echoes.
- **Limits.** `decisionModelLimits` gains `maxQuestions`: 64 a request for clef, 128 for the decider. `planDecision`
  refuses a larger request before sending it, and the eval's batching splits at the limit.
- **Answers checked, not trusted.** Read silently, a malformed answer would score as near-uniform and still count as
  answered.
  - The new adapters reject a whole response from a model not asked for, or one that can't be read. Usage is read
    first, so the rejection keeps the cost.
  - `DecisionPredictor` records a rejection as the model's failure (`output`): it keeps its cost share and is not
    retried.
  - A single malformed answer (wrong type, a choice outside the options, score levels not keyed `0..n-1`) is dropped,
    so only its question fails.
  - Jev's schema now accepts any `legend` (never read), since clef's allows any JSON per level.
  - Missing setup (no account ID, no list rate) is a `DecisionSetupError`, refused before any request and never
    retried. A Workers AI envelope carrying Cloudflare's authentication error (10000) is a 401.
- **List rate, the one exception to `usage.cost`.**
  - `DECISION_LIST_RATES` registers each model's published rate with its source and the day it was read: clef $0.24/M
    input, clef-flash $0.09/M, the decider $0.04/M, output free.
  - Cost is the response's `usage.cost` if a vendor ever sends one, else tokens × rate. A model routed to these vendors
    without a rate is refused before any call.
  - A price change is an edit there, reviewed like any other. Everywhere else, cost still comes from responses.
- **E8 (`pnpm eval -- models`, Actions → Decision models, `docs/MODELS.md`).**
  - Five raw-scale arms on the same sealed instances, states and requests, each from `full` and from `context`.
    Served questions go one per request (their states are per question); Twin's go in batches of 20, never above any
    model's own limit.
  - Served questions from real people (`EvalInstance.population`), plus Twin-2K-500 at k = 30.
  - A canary request per model first; people in chunks, all models per chunk, a chunk cut by the cap dropped for every
    model.
  - Probabilities compared after a temperature per model fitted leaving each person out (`looTemperatures`). Jev's
    T = 4 was fitted on Jev.
  - `MODELS_RULE`, fixed before the first run, calls each challenger `better`, `level`, `worse` or `insufficient`
    against Jev. Operational checks gate the recommendation on errors and latency; cost is reported, not gated.
- **Scope.** Offline only. No served config, shadow or flag variant names the new models; a `better` verdict leads to
  a shadow config and a backfill in their own ADR.

**Consequences.**
- **Configuration.**
  - The Cloudflare token used by the workflow needs Account · Workers AI · Read (`docs/DEPLOY.md`).
  - `PERPLEXITY_API_KEY`, until now optional for people search, also serves the decider.
  - The deployed Workers set no Cloudflare credentials, so serving is unchanged.
- **Fixtures.**
  - The Perplexity fixture is the response Perplexity documents as returned by a real call.
  - The clef fixtures are built from Cloudflare's published schemas. Neither vendor's API was reachable from the
    environment that wrote them: `api.perplexity.ai` is blocked by its egress policy, and it has no Cloudflare
    credentials.
  - The first run's `canary.json` holds recorded responses to replace both, as ADR-0009 did for Parallel.
- **Costs move with list prices.** A vendor that changes its price without Mimic's rate changing is mis-costed until
  someone edits the rate; the source link and date make that checkable.

**Result (2026-10-01; `docs/reports/e8-models.md`).** Actions run `36926382050`, eval run `01M3WP08Q7MSSY0772PRNCQE27`:
9 real people (462 served questions) and 200 Twin-2K-500 people at k = 30, $2.00. Verdict: keep Jev.
- On served questions no challenger is better. span-01 is `worse` (Δ log loss +0.058 [+0.028, +0.086]). Clef
  (+0.022), clef-flash (+0.018) and the decider (+0.008) are `level`, each about 4 points less accurate.
- On Twin, clef (−0.033), the decider (−0.025) and clef-flash (−0.014) beat Jev with intervals clear of 0.
- On raw probabilities every challenger beat Jev on served questions by 0.30 to 0.51 nats. Jev is the most
  overconfident (T ≈ 5.8), and one temperature per model reverses the served comparison.
- Every challenger fails the latency check (Jev 189 / 277 ms p50 / p95; clef's p95 is 5.9 s).
- The decider costs 8.7× Jev per prediction on 20-question batches, though its list rate is lower. Its token counts
  suggest it counts the state once per question.
- The canary's recorded requests and responses replaced the fixtures. Clef echoes the bare model name; both vendors
  report input tokens and no cost, as the adapters assumed.

## ADR-0069 — E8b: each decision model at its best, chosen by nested cross-validation (2026-10-01)

**Context.** E8 (ADR-0068) asked every decision model the same way and kept Jev. That compares models, not what each can
do:
- every request used Jev's templates, the state as served and scales as levels;
- clef predicted real users better from identity alone than from the whole state;
- asking scales as choices already helped Jev on Twin (ADR-0066).

Tuning each model on the people it is scored on would flatter whichever model has the most room to fit. With nine
served people that risk is large.

**Decision.**
- **A fixed grid, on Mimic's side** (`TUNE_SETTINGS`, `packages/eval/src/tuning.ts`). The Decisions APIs take no
  sampling parameters, so the grid covers what Mimic controls:
  - four views of the sealed state (`full`, `context`, `answers`, `derived`);
  - scales asked as levels or as choices;
  - the state as text;
  - plain wording.
  That makes ten settings, each with one temperature or one per question type: twenty configurations per model,
  searched exhaustively.
- **Nested leave-one-person-out selection** (`tune`).
  - A person is scored at the configuration chosen on everyone else.
  - The temperatures used to choose it leave out both the person and the one being scored.
  - Ties go to the earlier setting, so the incumbent keeps one.
  - The in-sample score of the chosen configuration is reported beside the nested one, to show the selection's
    optimism, along with how many folds agreed.
- **The same rule.** `MODELS_RULE`, unchanged: tuned challengers against tuned Jev.
  - Tuned Jev is also judged against Jev as served by the rule's quality checks. A pass sends its chosen setting to a
    shadow, in its own ADR.
- **One run.** `pnpm eval -- models --tune` (Actions → Decision models, `tune`) runs E8 and E8b together. E8's tables
  read only E8's settings, so the run also replicates E8. The cap is $15 by default with `--tune`; the run should
  cost about $9.

**Consequences.**
- About 4.5× E8's requests and about an hour of runner time. The workflow's timeout rises to 180 minutes.
- Free-text prompt optimization per model stays out until there are more served people (`docs/MODELS.md` §9).
- A tuned setting never reaches the primary directly: a recommendation goes to a shadow on new people first
  (ADR-0024).

**Amendment (2026-10-01, before the first E8b run).** An audit of the harness found three biases the tuning didn't
remove. Each is fixed or reported before any tuned data exists (`docs/MODELS.md` §9, "Bias controls"):
- **Uneven timeouts.** Jev, span-01, clef and the decider had 15 s and GLiDE 300 s. A slow answer was retried, could
  end as a uniform prediction, and its timed-out attempts left latency. Every vendor now gets
  `DECISION_TIMEOUT_MS` (300 s) in E8 and E8b, through `makeProviders`' `decisionTimeoutMs`. Production keeps each
  adapter's own timeout.
- **Twin people seen before.** The grid was designed after E8's first run on Twin people 1–200. The Decision models
  workflow gains `twin_offset`, and E8b's first run reads people 201–300 (100 people, about $6 for the five default
  models).
- **Several challengers.** The family-wise served interval (the rule's one-sided 5% split across challengers) is
  reported beside the verdict. `MODELS_RULE` is unchanged and still gates.

The served people can't be fresh, and that stays a stated limit. GLiDE is supported (ADR-0070) but not in this run.

**Result (2026-10-02; `docs/reports/e8b-tuning.md`).** Actions run `36943686226`, eval run
`01M3X0RN76Y4C8WY6V8AJP1M9C`: the 9 served people (462 questions) and Twin people 201–300 at k = 30. It cost $5.96, and
every canary passed. Verdict: keep Jev.
- **E8 replicated on the fresh Twin people.** Every Twin gap repeated within 0.007.
- **Tuned against tuned Jev, no challenger is better on served questions.**
  - clef-flash on `derived`: −0.028 [−0.058, +0.005], −1.7 points;
  - the decider: −0.015 [−0.043, +0.012], −3.1 points;
  - clef: −0.002, −2.8 points;
  - span-01: +0.051, `worse`.
  None of the family-wise intervals excludes 0. Every challenger also fails the latency check.
- **Nested selection was worth having.**
  - Jev's in-sample pick (`full+plain`, a temperature per type) claimed 1.150. Scored nested, it was 1.187, worse
    than untuned E8 (1.173).
  - All of that gap is the one person whose fold chose differently.
  - Only clef-flash's choice was stable on served questions (9 of 9 folds). On Twin, gains are at most 0.009 nats.
- **Tuned Jev is not better than Jev as served** (+0.008 served, −0.000 Twin). No shadow config or backfill follows.
- **Jev's full-state served score moved by 0.007 between E8's two runs on the same requests,** and nothing else's did.
  Served differences of that size in Jev are noise.
- **Proposed for the next run, not applied to this one:**
  - read latency over all of a model's arms, since Jev's p95 moved from 297 to 534 ms between arms in one job;
  - re-run once E7 has at least doubled the served people.

## ADR-0070 — Fastino's GLiDE in E8 and E8b, opt-in (2026-10-01)

**Context.** Fastino released GLiDE on 1 October: a decision model that takes Jev's request on its own API
(`POST https://api.fastino.ai/v1/systemone`, model `fastino/GLiDE`) and "thinks" further on a question it isn't
confident about. Fastino reports it ahead of Jev on the Decision Index; E8 asks whether that holds on Mimic's people.
Its contract differs from the other challengers in four ways (`docs.fastino.ai`, read 2026-10-01):
- **Score answers.** `score` is the winning level's index; the probability-weighted level is `expected_level`.
- **Cost.** It returns token counts and no cost. It is billed at $0.30/M input with the state counted once per
  question.
- **Cold start.** A cold model answers 425 for about a minute.
- **Timeout.** Fastino recommends a 300 s read timeout.

**Decision.**
- **Model and routing.** `fastino/glide` (`GLIDE_MODEL`) is a provider-neutral ID like ADR-0068's. `RoutedDecisions`
  sends `fastino/` to `FastinoDecisions`, which:
  - asks for `fastino/GLiDE` with exactly `model`, `state` and `questions` (Fastino returns 422 on any other field);
  - authenticates with `X-API-Key` from `FASTINO_API_KEY`;
  - accepts `glide` as the echo.
- **List rate.** `DECISION_LIST_RATES` registers $0.30/M input, output free, from Fastino's pricing page, as ADR-0068's
  exception allows.
- **Answers.** Levels are read from `probabilities` as for every model, so the integer `score` changes nothing. The
  same answer checks apply.
- **Waiting.**
  - On a 425 the adapter waits 60 s and asks again, up to three times, beyond the HTTP layer's short retries.
  - The timeout is 300 s.
  - Latency counts only the attempt that answered, as before.
- **Limits.** No question limit is documented, only 40,000 tokens per question with the state, which Mimic's states
  fit. Twin keeps batches of 20.
- **Supported, opt-in.** GLiDE is not in E8's or E8b's default arms (`OPT_IN_PREDICTORS`); it runs when named in
  `--predictors`, under the same `MODELS_RULE` and E8b grid. It would cost more than the five defaults together: about
  $5 on E8 and $19 on E8b at 200 Twin people (the defaults: about $2 and $9). The default caps stay $5 and $15, so a
  run that names it raises `max_usd`.

**Consequences.**
- The workflow passes `FASTINO_API_KEY` (a GitHub secret synced from Doppler). When GLiDE is named, a missing or
  unfunded key fails its canary, and the run goes on without it, naming it.
- `api.fastino.ai` is blocked from the environment that wrote the adapter. The fixtures are built from Fastino's
  documented shapes, and the first run that names GLiDE replaces them from its `canary.json` (as ADR-0068 did for
  clef).
- GLiDE's adaptive thinking may widen its latency tail. E8's operational check reads p95 as it does for every model.

## ADR-0071 — E9: learning curves for question selection on recorded answers (2026-10-02)

**Context.** Mimic's selector has never been measured on real answers. `select` replays served pools that an online
policy chose (biased, ADR-0018), and E3b needs about 64 real people per arm; there are 9. Twin-2K-500 gives 2,058
people the same full questionnaire, so a policy can choose from a person's whole pool and get the answer they gave.

**Decision.**
- **E9** (`pnpm eval -- curves`, `docs/CURVES.md`) runs selection policies over each Twin person's 420 typed wave 1–3
  answers. Jev predicts their wave 4 decisions from a sealed state holding exactly the answers asked, at
  k = 0, 3, 6, 10, 15, 20, 25 and 30, each (policy, k) at a temperature fitted leaving each person out.
- **Leakage controls.**
  - People are split by hash into train (population statistics only), dev (iteration) and test (read once).
  - Wave 4 questions are split by question into R, whose questions a policy may read, and T, the only ones scored.
  - Pool items matching any wave 4 question are dropped.
- **Cross-person data.** Two policies order the pool with a persona posterior over the train people's answers. As
  with `item_stats` (ADR-0027), the population only ranks candidates; it never enters a prompt or a state. This is
  the explicit flag invariant 8 allows.
- **`CURVES_RULE`**, fixed before the first run: a policy beats `random` if, on at least 30 people, the interval of its
  area under the log-loss curve (k = 3 … 30, by person, 90%) lies below 0 and its accuracy at 30 is at most 1 point
  lower.
- **Iteration and confirmation.**
  - Dev rounds test one hypothesis each and choose knobs leaving each person out.
  - Rounds stop at a plateau: two rounds under 0.003 nats.
  - The final policy set is committed before the test people are read once.
- **A request cache** (`CachingGateway`) keeps every answered decision request on disk by its content hash. A hit
  makes no call and costs nothing; a miss is logged as usual (invariant 5). This freezes Jev's answer to a request at
  its first draw, so policies sending the same request see the same answer.

**Consequences.**
- Results rank selection principles for Jev on Twin's questions. A winner reaches real users only as an arm
  (`cfg.e9.*`), never as `cfg.default`, and only Jev-only principles port to generated questions.
- `twin.ts` keeps each item's block and question ID and reads the export line by line (the full file is about
  470 MB). `importTwin` is unchanged otherwise, its 400-item cap included.
- `packages/eval/scripts/twin-rows.py` fetches the export through the datasets-server API where Hugging Face's CDN is
  blocked.

## ADR-0072 — An anchor set may fix its order (2026-10-02)

**Context.** Anchors are seeded at intake in a per-person random order (PLAN §9.3), which suits a set of equals.
E9 (ADR-0071) plans openings offline: a sequence chosen greedily, where each question is picked given the ones before
it. Shuffled, such a sequence is no longer the one that was measured.

**Decision.** `anchors.order` (optional): `fixed` seeds the set in its own order; absent or `shuffled` keeps the
per-person shuffle. Deselected categories still drop their anchors, and the rest keep their order (ADR-0040). The
field is optional and undefaulted, so every existing config, and its hash, is unchanged.

**Consequences.** An arm can ship an opening exactly as E9 measured it (`custom-<policy>` in `pnpm eval -- curves`).
No served config sets it yet.
