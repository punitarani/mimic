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

## ADR-0022 — Continuous deployment to Cloudflare from Doppler (2026-09-30)

Prod deploys itself: `.github/workflows/cd.yml` runs when CI completes green on `main`, checks out the commit CI
tested, and runs `doppler run -- pnpm deploy:prod`. The steps are in `docs/DEPLOY.md`. `scripts/provision.sh`, the
per-app deploy scripts and `db:migrate:{preview,prod}` are gone.

- **Doppler is the source of truth.** The only GitHub secret is `DOPPLER_TOKEN`, on the `production` environment.
  Secrets go up with each deploy (`wrangler deploy --secrets-file`), so Doppler and the Workers can't drift, and a
  first deploy works. `wrangler secret bulk` would need the Worker to exist already, and wrangler refuses to create
  a Worker whose `secrets.required` are unset. Each Worker's `secrets.required` lists the names it gets.
- **Resources are found or created by name** through the Cloudflare API on every deploy. Wrangler's
  auto-provisioning is not used: it gives each Worker its own KV namespace and never creates queues or Vectorize
  indexes. Real IDs go into a gitignored `wrangler.deploy.jsonc`; the checked-in configs keep `REPLACE_ME_*`. The
  eval CLI's remote commands use the same generated file (`pnpm deploy:config`).
- **The lab is behind Cloudflare Access in prod.** The deploy creates the Access app and policy. The web Worker is
  reachable only on `mimic.punitarani.com`, because `workers_dev` and `preview_urls` are off. Preview is on
  `workers.dev` with no Access in front, so it gets no `ADMIN_EMAILS` and its lab is closed.
- **Gates:**
  - A preflight job fails fast, naming anything missing.
  - Migrations run before code.
  - A smoke test checks the landing page, `/api/health` and the Access redirect on `/lab`.
  - Deploys are serialised and never cancelled mid-flight.
- **Only prod is deployed continuously.** Preview is deployed by hand from any Doppler config.
