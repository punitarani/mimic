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
