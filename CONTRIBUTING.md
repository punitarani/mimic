# Contributing to Mimic

The details the [README](README.md) leaves out: setup, environment variables, commands, conventions and deploys.
The spec is [docs/PLAN.md](docs/PLAN.md). Every deviation from it gets a short ADR in [docs/DECISIONS.md](docs/DECISIONS.md).

## Setup

| Need | Version / note |
| --- | --- |
| Node | ≥ 22.12 |
| pnpm | 10.33 (`corepack enable` picks up the pinned version) |
| OpenRouter API key | Required. Jev, every LLM and embeddings go through it. |
| Exa API key | Optional. Needed only for identity web search. |
| Cloudflare account | Not needed locally. D1, R2, KV and Queues run in Miniflare. |

```bash
pnpm i
cp apps/web/.dev.vars.example apps/web/.dev.vars && cp apps/worker/.dev.vars.example apps/worker/.dev.vars
pnpm dev    # migrations + egress relay + worker :8787 + web :3000
```

Open http://localhost:3000/new?invite=mimic-dev. `pnpm dev` also copies a missing `.dev.vars` from its example, and fires
the worker's cron every 10 minutes (stale-job requeue, missing shadows, snapshots; ADR-0019).

## Environment variables

Local values live in `apps/web/.dev.vars` and `apps/worker/.dev.vars`. Both files are gitignored. Put provider keys in
**both** files. There is no `.env`; the templates are [`apps/web/.dev.vars.example`](apps/web/.dev.vars.example) and
[`apps/worker/.dev.vars.example`](apps/worker/.dev.vars.example).

| Variable | Where | Required | Purpose |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | both | yes | Jev, the LLMs and embeddings |
| `EXA_API_KEY` | both | for web search | Identity search and enrichment. Without it, untick "Search the public web" on `/new`. |
| `PARALLEL_API_KEY` | both | no | Only with `ENRICH_PROVIDER=parallel` |
| `PERPLEXITY_API_KEY` | both | no | Only with `SEARCH_PROVIDER=perplexity` |
| `SEARCH_PROVIDER` | both | no | `exa` (default), `perplexity`, `fixture` or `none` |
| `ENRICH_PROVIDER` | both | no | `exa` (default), `parallel`, `fixture` or `none` |
| `EGRESS_RELAY` | both | keep as is | Sends provider calls through `scripts/egress-relay.mjs`, which forwards them with Node's proxy-aware fetch (ADR-0002) |
| `DEV_MODE` | both | local only | `1` opens `/lab` and every mimic to any visitor. The deploy preflight refuses it. |
| `SESSION_SECRET` | web | yes | Signs the participant cookie |
| `INVITE_CODES` | web | yes | Comma-separated invite codes (dev: `mimic-dev`) |
| `ADMIN_EMAILS` | web | deployed | Comma-separated emails allowed into `/lab` (open to anyone under `DEV_MODE=1`) |

To run an offline identity demo with fictional people, set `SEARCH_PROVIDER=fixture` and `ENRICH_PROVIDER=fixture` in
both files.

<details>
<summary>Deployed settings (Doppler)</summary>

Each one overrides the environment's checked-in value in `wrangler.jsonc`; leave it unset to keep that value. See
[docs/DEPLOY.md](docs/DEPLOY.md).

| Name | Allowed | Prod value |
| --- | --- | --- |
| `EMBEDDINGS_PROVIDER` | `workers-ai`, `openrouter` | `openrouter` |
| `VECTOR_BACKEND` | `vectorize`, `sql` | `vectorize` |

The spend caps are the Flagship flags `budget-usd` (default `1`) and `budget-session-share` (default `0.8`), not
Doppler settings (ADR-0035, ADR-0052); `BUDGET_USD` and `BUDGET_SESSION_SHARE` apply only in `.dev.vars`.

</details>

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Lint + typecheck + test. **Run it before every commit.** CI runs the same checks. |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm test` | Vitest on recorded fixtures (no live calls), plus the scripts' node tests |
| `pnpm test:live` | Live smoke tests (sets `LIVE=1`). Needs real keys and costs a little. |
| `pnpm db:generate` | Generates a Drizzle migration after a schema change |
| `pnpm db:migrate:local` | Applies migrations to the local D1 (`pnpm dev` does this too) |
| `pnpm --filter @mimic/core gen:docs` | Regenerates `docs/prompts`, `docs/ontology` and `docs/schemas` from `packages/core` (a test checks they match) |
| `pnpm eval -- --help` | Eval CLI: `export`, `replay`, `select`, `import`, `report`, `session`, `evaluate`, `diagnose`, `optimize` |
| `pnpm backfill --predictor <id>` | Runs a new predictor on questions already served (ADR-0024, ADR-0037) |
| `pnpm deploy:dry-run` | OpenNext build + `wrangler --dry-run`, like CI's build job. No credentials needed. |

Eval loop on dev data: `pnpm eval -- export --env local --out data/x.sqlite`, then `replay --data data/x.sqlite`, then
`report --data … --run <id> --to local` (shown in `/lab`). Prompt optimization is covered in
[docs/OPTIMIZATION.md](docs/OPTIMIZATION.md).

## Rules that PRs are held to

The research invariants in [PLAN §3](docs/PLAN.md) are non-negotiable. If a change seems to need breaking one, ask
first. In short:

- **Sealed predictions.** A prediction for question *t* uses only answers with seq < *t*, and stores `stateHash` and `evidenceSeqMax`.
- **Version everything.** Configs are immutable and hash-identified, so a change means a new config. Any prompt edit means a new prompt ID; then run `gen:docs`.
- **Log every model call** through `withModelCall()` (via `Gateway`). Read cost from `usage.cost`, and never hardcode prices.
- **Keys stay server-side.** Never call a provider from client code.
- **Research exports** include only `consent_research` mimics. No cross-person data may enter a prompt or a state.
- **Style.** TypeScript strict with no `any`. Use zod at every boundary. IDs are ULIDs and times are integer milliseconds.
- **Model calls.** Don't send `temperature` to LLMs; use `reasoning.effort`. Pin Jev to `typesafe/jev-1.13`.
- **Tests** use recorded fixtures in `packages/adapters/fixtures/`, and CI makes no live calls. Never report metrics from simulated users.
- **Adding a predictor** means a new config plus `pnpm backfill` for questions already served (ADR-0024).

[CLAUDE.md](CLAUDE.md) has the full list.

## Pull requests

- Branch from `main`, and open the PR against `main`.
- `pnpm check` passes.
- New config fields, tables or prompts are documented in PLAN.md or DECISIONS.md.
- UI changes follow PLAN §10.2 and the session design tokens in `apps/web/app/globals.css`. Use sentence case, support
  the keyboard, keep focus visible and respect reduced motion.

## Deploying

Prod deploys from `.github/workflows/cd.yml` after CI is green on `main`. To deploy by hand, run
`doppler run -- pnpm deploy:prod`. Secrets live in Doppler (`mimic/prd`), which syncs them to GitHub. The required ones are
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_URL`, `OPENROUTER_API_KEY`, `SESSION_SECRET`, `INVITE_CODES`
and `ADMIN_EMAILS`. [docs/DEPLOY.md](docs/DEPLOY.md) covers token scopes, preview, observability and limits.
