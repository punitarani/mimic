# Mimic: guide for Claude Code

Mimic learns a person from a short, adaptive Q&A session and persists a "mimic" that predicts their decisions. It is also a research platform for comparing cheap LLMs (GPT-6 Luna, DeepSeek V4.1 Flash, GLM 5.3 Flash) against a decision model (TypeSafe Jev) at that task.

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
doppler run -- pnpm deploy:prod   # what CD runs after green CI on main (docs/DEPLOY.md); also deploy:preview
doppler run -- pnpm deploy:preflight | deploy:config --env prod   # checks only | write wrangler.deploy.jsonc
pnpm eval -- <export|replay|select|import|report|session> ...
```

`pnpm dev` serves the web app on http://localhost:3000 and the worker on http://localhost:8787. It copies
`.dev.vars.example` to `.dev.vars` in both apps on first run (dev invite code: `mimic-dev`).
It also fires the worker's cron every 10 minutes (stale-job requeue, missing shadows, snapshots; ADR-0019).

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
packages/adapters  OpenRouter chat, Jev decisions, OpenAI-decisions stub, Exa, Parallel, Perplexity, embeddings
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
- IDs are ULIDs; times are integer milliseconds; money is USD taken from provider `usage.cost`. Never hardcode prices.
- Configs are immutable, identified by `sha256(canonicalJson(config))`. A change means a new config row. Prompts live in `packages/core/src/prompts.ts` and are mirrored to `docs/prompts/{id}.md` (`pnpm --filter @mimic/core gen:docs`); any edit means a new ID.
- Queue handlers are idempotent (use the `jobs` ledger). Derived-state writes are monotonic by `seqUpTo`.
- Pin Jev to `typesafe/jev-1.13`. Batch all Jev questions that share a state into one request, and keep states within the §9.9 token budget (Jev context is 32K).
- Don't send `temperature` to any LLM. Use `reasoning.effort`. JSON-schema calls set `provider.require_parameters: true`.
- Default LLM is `deepseek/deepseek-v4.1-flash`, routed to Wafer first (ADR-0004); GPT-6 Luna and GLM 5.3 Flash are alternatives and shadows.
- Order prompts for caching: stable prefix (system, ontology, rules) first, variable content last.
- Test with Vitest, using recorded fixtures in `packages/adapters/fixtures/`. CI makes no live calls. Worker code tests use `@cloudflare/vitest-pool-workers`.
- Use simulated users for smoke tests only. Never report metrics from LLM-simulated users.
- UI: Tailwind with shadcn-style components; follow PLAN §10.2. The session page and model panel follow the Claude Design handoff `Mimic Session v2` (ADR-0021): design tokens (fog, sheet, graphite, slate, rule, ink, moss, rust; light and dark) live in `apps/web/app/globals.css`, components in `apps/web/components/session/`. Sentence case, plain verbs, keyboard support for answers, visible focus states, respect reduced motion.
- Privacy: self-only mimics; every sourced fact shows its source and can be removed; hard delete covers D1, R2, Vectorize and KV.

## Before implementing an adapter

Check the provider's current docs, since these APIs are new and change: OpenRouter chat, the OpenRouter Decisions API (`/api/alpha/decisions`), Exa people search, Parallel Task API. Record fixtures from one real call, then write contract tests against the fixtures.

## Environment

- Bindings (both apps): `DB` (D1), `BLOBS` (R2), `CACHE` (KV), `VEC` (Vectorize, metadata indexes on `mimicId` and `kind`; deployed envs only), `JOBS` (Queue), `AI` (Workers AI; deployed envs only), `RL` (rate limiter).
- Secrets: `OPENROUTER_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `PERPLEXITY_API_KEY` (optional), `SESSION_SECRET`, `ADMIN_EMAILS`, `INVITE_CODES`. Keep local copies in `.dev.vars`, which is gitignored.
- Local dev in the Claude Code remote env: provider keys are injected by the outbound proxy and can't be read. `EGRESS_RELAY=http://127.0.0.1:8790` routes provider calls from workerd and Next through `scripts/egress-relay.mjs`, which uses Node's proxy-aware fetch (ADR-0002). Parallel's API host is blocked by this env's egress policy.
- Environments: dev (local), preview and prod, each with separate resources. Prod deploys from `.github/workflows/cd.yml`
  after green CI on `main`. Every secret lives in Doppler (`mimic/prd`); the only GitHub secret is `DOPPLER_TOKEN`.
  `scripts/deploy` finds or creates the resources and pushes secrets on each deploy (docs/DEPLOY.md, ADR-0022).

## Definition of done (every milestone)

- [ ] `pnpm check` (lint, typecheck and test) passes.
- [ ] Every acceptance criterion in the milestone is checked off in the PR description.
- [ ] New config fields, tables or prompts are documented in PLAN.md or DECISIONS.md.
