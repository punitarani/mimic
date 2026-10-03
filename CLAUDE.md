# Mimic: guide for Claude Code

Mimic learns a person from a short, adaptive Q&A session and persists a "mimic" that predicts their decisions. It is also a research platform for comparing cheap LLMs (GPT-6 Luna, DeepSeek V4.1 Flash, GLM 5.3 Flash, MiMo V2.6 Flash, Qwen3.8 Flash) against a decision model (TypeSafe Jev) at that task.

- Spec (source of truth): `docs/PLAN.md`
- Decision log: `docs/DECISIONS.md`. Add one short ADR per deviation from the plan.
- Work order: milestones M0–M8 in `docs/PLAN.md` §14. Finish each milestone's acceptance criteria before starting the next.

## Commands

```
pnpm i
pnpm dev                    # migrations + egress relay + worker (wrangler dev) + web (next dev); local D1/R2/KV/Queues
pnpm typecheck              # tsc --noEmit across the workspace
pnpm lint                   # biome
pnpm check                  # lint + typecheck + test (use this before every commit)
pnpm test                   # vitest; no live provider calls
pnpm test:live              # live smoke tests; requires keys (or the dev proxy) and LIVE=1
pnpm db:generate            # drizzle-kit generate
pnpm db:migrate:local       # remote migrations run as part of each deploy
pnpm deploy:dry-run         # OpenNext build + wrangler --dry-run for both Workers (CI's build job)
doppler run -- pnpm deploy:prod   # what CD runs after green CI on main (docs/DEPLOY.md); also deploy:preview
doppler run -- pnpm deploy:preflight | deploy:config --env prod   # checks only | write wrangler.deploy.jsonc
pnpm eval -- <export|replay|select|import|report|session|rubric|arms|cohort|evaluate|diagnose|optimize|benchmark|evidence|models|curves|probes|drafts|gates|transfer|ensemble|population|footprint> ...
pnpm backfill --predictor <id>[,<id>] [--env local|prod] [--rate n] [--retry-failed] [--yes]   # new predictors on served questions (ADR-0024, ADR-0037)
pnpm relabel:predictors [--env local|preview|prod] [--reverse] [--yes]   # stored jev: IDs → decision:, rerouted rows → the model that answered (ADR-0054)
pnpm flags:check [--create-missing]   # Flagship app `mimic` vs the flag registry; needs CLOUDFLARE_API_TOKEN/ACCOUNT_ID (ADR-0051)
```

`pnpm dev` serves the web app on http://localhost:3000 and the worker on http://localhost:8787. It copies
`.dev.vars.example` to `.dev.vars` in both apps on first run (dev invite code: `mimic-dev`, or open
http://localhost:3000/new?invite=mimic-dev).
It also fires the worker's cron every 10 minutes (stale-job requeue, missing shadows, snapshots; ADR-0019).

Prompt optimization (ADR-0028, docs/OPTIMIZATION.md): `pnpm eval -- evaluate --from stored --data x.sqlite` reports on
stored predictions for free; `pnpm eval -- optimize --data x.sqlite --predictor decision:typesafe/jev-1.13 --max-usd 2` runs a
capped GEPA loop. In prod, run Actions → Optimize. A winner ships only as a registered variant
(`llm:<model>@<version>`, `packages/core/src/components.ts`), first as a shadow via `pnpm backfill`.

Eval loop on dev data: `pnpm eval -- export --env local --out data/x.sqlite`, then `replay --data data/x.sqlite`, then
`report --data … --run <id> --to local` (shown in `/lab`). Reproducing online predictions needs an export made with
`--keep-identity`: internal use only, never share it (ADR-0018). Sealed states pin their derived data to
`questions.state_at` so replay rebuilds them exactly (ADR-0017); load states with `loadMimicDataAt`, not the current
trait rows.

## Repo map

```
apps/web           Next.js on Workers (@opennextjs/cloudflare): UI + synchronous route handlers
apps/worker        Queue consumer (async jobs) + cron
packages/core      Pure TS engine. Must not import Cloudflare, Next or Node-only modules; receives deps by injection.
packages/adapters  OpenRouter chat, decisions (Jev, span-01; clef on Workers AI; Perplexity's decider; Fastino's GLiDE), OpenAI-decisions stub, Exa, Parallel, Perplexity, embeddings
packages/db        Drizzle schema + migrations + Store; R2/KV/Vectorize helpers; runtime wiring (db/runtime)
packages/eval      Node CLI for offline evaluation and the scripted session loop
docs/              PLAN.md, DECISIONS.md, ontology/*.json, prompts/*.md (generated from packages/core)
scripts/           dev orchestrator, egress relay, deploy (resources, secrets, Access, smoke)
```

## Invariants (PLAN §3). Never break these.

1. Sealed predictions. A prediction for question t uses a state built only from answers with seq < t. Store `stateHash` and `evidenceSeqMax`. There is a test for this; keep it passing.
2. Primary and baseline first. Both predictions are persisted before a question is returned to the client.
3. Evidence is the source of truth. Traits, insights, the KG and snapshots are derived, versioned and recomputable.
4. Version everything. Every question, prediction, trait estimate and insight stores `configHash`, `promptVersion` and the provider's model snapshot ID.
5. Log every model and search call through `withModelCall()` (via `Gateway`): a `model_calls` row plus an R2 trace with keys redacted.
6. Keep the baseline on. Every scored question gets a context-only baseline prediction.
7. Research exports require consent. Only `consent_research` mimics go into exports. The dev/test split is `hash(mimicId)` and never changes.
8. No cross-person data in prompts or states, unless an experiment explicitly flags it.
9. Keys stay server-side. Never call a provider from client code.

If a task seems to require breaking one of these, stop and ask.

## Conventions

- TypeScript strict, no `any`. Validate with zod at every boundary: HTTP bodies, provider responses, D1 JSON columns, queue messages, and `mimic.json`.
- IDs are ULIDs; times are integer milliseconds; money is USD taken from provider `usage.cost`. Never hardcode prices,
  with one exception: a decisions vendor that returns no cost (Workers AI, Perplexity) is priced at the list rate
  registered with its source in `DECISION_LIST_RATES` (`packages/adapters/src/decisions.ts`, ADR-0068).
- Configs are immutable, identified by `sha256(canonicalJson(config))`. A change means a new config row. Prompts live in `packages/core/src/prompts.ts` and are mirrored to `docs/prompts/{id}.md` (`pnpm --filter @mimic/core gen:docs`); any edit means a new ID.
- Queue handlers are idempotent (use the `jobs` ledger). Derived-state writes are monotonic by `seqUpTo`.
- Pin Jev to `typesafe/jev-1.13`. Batch all Jev questions that share a state into one request, and keep states within the §9.9 token budget (Jev context is 32K).
- Don't send `temperature` to any LLM. Use `reasoning.effort`, or a `reasoning.max_tokens` budget for models that take no effort level (MiMo Flash, Qwen Flash). Keep reasoning on at low, and cap `max_tokens` per model from measured usage (`predict.v2`, ADR-0041). JSON-schema calls set `provider.require_parameters: true`.
- Default LLM is `deepseek/deepseek-v4.1-flash`, routed to Wafer first (ADR-0004); GPT-6 Luna and GLM 5.3 Flash are alternatives and shadows, as are MiMo V2.6 Flash and Qwen3.8 Flash (ADR-0025). Since `cfg.default.v6` every LLM shadow runs `@predict.v2`, which is registered only for the models it has measured settings for (ADR-0041). Since `cfg.default.v7` the primary is calibrated Jev (`decision:typesafe/jev-1.13@jev-predict.v2`; configs v3–v8 spell it `jev:`, a permanent alias, ADR-0054): selection scores candidates on Jev's raw scale and only the stored prediction is rescaled (`selectionView`); anything selection reads back from storage goes through `rawScale`, and the reasoning-off Qwen control is retired (ADR-0048). `cfg.default.v9` (ADR-0065) adds two view shadows, Jev on derived data (`@jev-derived.v1`) and DeepSeek on the context alone (`@predict.v2-context`): a variant's `harness.stateView` reads a view of the sealed state and keeps its hash; `cfg.default.v10` (ADR-0066) adds Jev asked scale questions as choices (`@jev-scales.v1`, `harness.scoreAs`). E3b stays on v8, E7 runs on the default. Adding a predictor means a new config plus `pnpm backfill` for questions already served (ADR-0024).
- Predictor IDs are `decision:<model>[@<version>]` (the OpenRouter Decisions API: Jev, span-01) or `llm:<model>[@<version>]`. `jev:` is the decision kind's old name, read as `decision:` for ever because hashed configs spell it; never write it. The Store returns IDs canonical; compare any other ID (a config's, a job's, a CLI flag's) through `canonicalPredictorId` (ADR-0054). Decision models
  outside OpenRouter have provider-neutral IDs with the vendor as prefix (`cloudflare/clef`, `cloudflare/clef-flash`,
  `perplexity/pplx-decider-v1-27b`, `fastino/glide`; `@` would read as a prompt version); `RoutedDecisions` sends each
  to its vendor and no served config names them yet (ADR-0068, ADR-0070).
- Question selection is `voi` (value of information) since `cfg.default.v4`: a belief state per person (uncertainty, conflict, weakness, coverage, exposure) scores pooled candidates; `gen.v2` targets the facets with the highest need; cross-person `item_stats` rank candidates and never enter a prompt or a state. Spec: `docs/SELECTION.md`, ADR-0027. `cfg.default.v8` (ADR-0044) runs it on ontology v2 with `gen.v3`, balances categories and facet groups, holds sensitive questions back for the first six answers, sweeps consented sensitive facets, and keeps two coverage deadlines (every facet group by question 20, every consented sensitive facet by 30). `entropy`, `bald`, `coverage` and `random` stay as controls. E3b (ADR-0045) tests v8 against `cfg.e3b.control` (v8 without M12's balance); set it up from the preset in `/lab` (`setupPreset`, draft only) and read it with `pnpm eval -- arms`. `/lab`, `arms` and `rubric` keep real people apart from scripted and imported ones (`populationOf`); never report the latter as results.
- E6 (ADR-0053, `docs/EVIDENCE.md`) runs before E3b: it measures whether predictors learn from a person's answers,
  and from what form of them (`viewState`: `context`, `full`, `answers`, `derived`, `relevant`), on sealed served
  questions and Twin-2K-500. Run it from Actions → Evidence (`pnpm eval -- evidence`). `EVIDENCE_RULE` decides, and
  was fixed before the first run. The first run's verdict is `questions` (`docs/reports/e6-evidence.md`): predictors learn
  from Twin's survey answers but not from Mimic's served ones. E3b therefore waits for a held-out probe set (E7,
  ADR-0062, `docs/PROBE.md`; the `e7` preset in `/lab`, read with Actions → Readout or `pnpm eval -- probes`): fourteen probes per person at
  fixed points, three shared, two repeats and the rest at a measured distance (answers on their facets), since the Twin
  benchmark (`docs/reports/twin-benchmark.md`) showed that Twin's lift is transfer from demographics and scales to
  product choices and that what the state keeps beyond the budget decides which domains transfer (`docs/EVIDENCE.md`
  §8, `docs/RESEARCH.md` §10).
- E8 (ADR-0068, `docs/MODELS.md`) compares decision models: Jev, span-01, clef, clef-flash and Perplexity's decider
  (Fastino's GLiDE is supported and runs when named in `--predictors`, ADR-0070) on the same sealed states and requests,
  served questions (real people) and Twin-2K-500 at k = 30, after a temperature per model fitted leaving each person
  out; `MODELS_RULE` decides whether a challenger earns a shadow. Run it from Actions → Decision models
  (`pnpm eval -- models`); a canary request per model runs first, and in the workflow a model that fails it is left out
  and named. The first run's verdict is keep Jev (`docs/reports/e8-models.md`): the challengers win on Twin and lose on
  served questions, and each is slower; Perplexity's decider came closest. E8b (`--tune`, ADR-0069, `docs/MODELS.md` §9)
  re-runs it with every model at its best: a fixed grid of request settings, each chosen by nested leave-one-person-out
  cross-validation, so no person's answers choose their own setting. Its verdict is also keep Jev
  (`docs/reports/e8b-tuning.md`): clef-flash on derived data came closest, and on nine served people tuning didn't
  generalize.
- E9 (ADR-0071, `docs/CURVES.md`) measures question selection on recorded answers: policies ask each Twin-2K-500
  person up to 30 of their own 420 wave 1–3 answers, and Jev predicts their wave 4 decisions after each checkpoint
  (`pnpm eval -- curves`; data via `packages/eval/scripts/twin-rows.py`). People split by hash into train (population
  statistics, which only order the pool), dev (iteration rounds) and test (read once); `CURVES_RULE` compares each
  policy with random. A winner goes to real users as an arm, never as the default. The pre-registered result
  (`docs/reports/e9-curves.md` §T, ADR-0073): asking political views and income once the trust ramp opens beats
  production's opening for Jev, mostly on decisions about policies. It ships as `cfg.e9.opening` (`anchors.e9.v1`,
  `anchors.order: 'fixed'`), the `e9` preset in `/lab` against `cfg.e7.probes`. Jev's own uncertainty doesn't beat
  random at choosing.
- Scope and consent (ADR-0040, `docs/CATEGORIES.md`): every facet has a category (`psychology`, `values`, `life`, `work`) and sensitive facets a sensitive area (`politics`, `religion`, `sexuality`, `health`, `money`), each behind its own consent (ticked by default at intake, ADR-0049); special-category areas also need a confirmation, and declined facets ("Prefer not to say") are blocked (ADR-0050, both enforced in `facetAllowed`). Get facets through `facetsFor` (scoped by default) and data through the loaders (which hide out-of-scope answers, traits, insights and facts); never read the ontology directly for anything a person will see or a model will be asked. Only direct, consented questions may populate a sensitive facet: never infer one from other answers or web facts.
- Research directions and their experiments live in `docs/RESEARCH.md`. The evals behind them: `transfer` (what an
  export loses, ADR-0057), `ensemble` (pools of stored predictions, ADR-0058), `population` (a synthetic cohort,
  ADR-0059), `footprint` (own exports → questions to verify, ADR-0061); `replay --evidence surprise|novelty` and
  `--state card` test what a state should keep (ADR-0056); `replay --per-target [--embed]` retrieves for each question,
  and `--evidence fill` spends the whole budget (ADR-0064). Other agents update a mimic only by appending typed
  observations (`POST /observations`, ADR-0060); nothing else is writable from outside.
- Order prompts for caching: stable prefix (system, ontology, rules) first, variable content last.
- Test with Vitest, using recorded fixtures in `packages/adapters/fixtures/`. CI makes no live calls. Worker code tests use `@cloudflare/vitest-pool-workers`.
- Use simulated users for smoke tests only. Never report metrics from LLM-simulated users.
- UI: Tailwind with shadcn-style components; follow PLAN §10.2. The session page and model panel follow the Claude Design handoff `Mimic Session v2` (ADR-0021): design tokens (fog, sheet, graphite, slate, rule, ink, moss, rust; light and dark) live in `apps/web/app/globals.css`, components in `apps/web/components/session/`. Sentence case, plain verbs, keyboard support for answers, visible focus states, respect reduced motion.
- Privacy: self-only mimics; every sourced fact shows its source and can be removed; hard delete covers D1, R2, Vectorize and KV.

## Before implementing an adapter

Check the provider's current docs, since these APIs are new and change: OpenRouter chat, the OpenRouter Decisions API (`/api/alpha/decisions`), Exa people search, Parallel Task API. Record fixtures from one real call, then write contract tests against the fixtures.

## Environment

- Bindings (both apps): `DB` (D1), `BLOBS` (R2), `CACHE` (KV), `VEC` (Vectorize, metadata indexes on `mimicId` and `kind`; deployed envs only), `JOBS` (Queue), `IDENTITY_JOBS` (Queue for `identity.*`, so sign-up never waits behind other jobs; ADR-0034), `AI` (Workers AI; deployed envs only), `RL` (rate limiter), `FLAGS` (Cloudflare Flagship app `mimic`; prod only: unbound means every flag reads its default; ADR-0051).
- Secrets: `OPENROUTER_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `PERPLEXITY_API_KEY` (optional), `FASTINO_API_KEY` (optional, E8 only), `SESSION_SECRET`, `ADMIN_EMAILS`, `INVITE_CODES`. Keep local copies in `.dev.vars`, which is gitignored. Settings (Worker vars in `wrangler.jsonc`, which Doppler may override): `SEARCH_PROVIDER`, `ENRICH_PROVIDER`, `EMBEDDINGS_PROVIDER`, `VECTOR_BACKEND` (`scripts/deploy/settings.mjs`). Spend caps are the flags `budget-usd` and `budget-session-share` (ADR-0035, ADR-0052); `BUDGET_USD` and `BUDGET_SESSION_SHARE` remain only for `.dev.vars`.
- Flags (ADR-0051, docs/CHALLENGER.md): every flag is defined once in `FLAG_SPECS` (`packages/core/src/flags.ts`); read them through `FlagReader` in core and `flaggedEnv` in `packages/db`, never the binding directly. `decisions-model` (`jev` | `span-01`) picks the model for Jev's served predictions and defaults to `jev`, and a rerouted row is stored under the model that answered (`servedPredictorId`, ADR-0054); `budget-usd` and `budget-session-share` are the spend caps (in prod the flags are their only source); `use-invite-code` (on by default) gates sign-up on `INVITE_CODES` (ADR-0055). Every read has a code default that equals the behaviour before the flag. Only runtime levers are flags (ADR-0052): provider choices (`SEARCH_PROVIDER`, `ENRICH_PROVIDER`, `EMBEDDINGS_PROVIDER`) and `VECTOR_BACKEND` are Worker vars in `wrangler.jsonc`, and secrets stay secrets. Adding a flag means a registry entry plus the flag in the `mimic` app; `pnpm flags:check` (CI's Flags workflow and deploy preflight) fails until both agree.
- Local dev in the Claude Code remote env: provider keys are injected by the outbound proxy and can't be read. `EGRESS_RELAY=http://127.0.0.1:8790` routes provider calls from workerd and Next through `scripts/egress-relay.mjs`, which uses Node's proxy-aware fetch (ADR-0002). Parallel's API host is blocked by this env's egress policy, and so are `api.perplexity.ai` and `api.fastino.ai`. The eval CLI and
  `pnpm test:live` reach clef over Workers AI's REST API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
  (Workers AI: Read), never through the relay; Perplexity's decider reads `PERPLEXITY_API_KEY` (ADR-0068), and GLiDE
  `FASTINO_API_KEY` (ADR-0070).
- Environments: dev (local), preview and prod, each with separate resources. Prod deploys from `.github/workflows/cd.yml`
  after green CI on `main`. Every secret lives in Doppler (`mimic/prd`), synced to GitHub repository
  secrets. `scripts/deploy` finds or creates the resources and pushes secrets and settings on each deploy
  (docs/DEPLOY.md, ADR-0022).

## Definition of done (every milestone)

- [ ] `pnpm check` (lint, typecheck and test) passes.
- [ ] Every acceptance criterion in the milestone is checked off in the PR description.
- [ ] New config fields, tables or prompts are documented in PLAN.md or DECISIONS.md.
