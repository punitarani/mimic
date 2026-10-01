# Deploying Mimic

Production is https://mimic.punitarani.com. It is deployed by `.github/workflows/cd.yml` after CI
(`.github/workflows/ci.yml`: lint, typecheck, test and a deploy dry run) goes green on a push to `main`. There is one
command. CD runs `pnpm deploy:prod` with the repository secrets that Doppler syncs to GitHub; locally it's:

```
doppler run -- pnpm deploy:prod
```

The command runs `scripts/deploy/deploy.mjs`. Every step is idempotent, so a re-run is always safe:

| Step | What it does |
| --- | --- |
| Preflight | Checks that every name below is set, that the settings are valid and their providers' keys are present, that `APP_URL` is the custom domain, and that the Cloudflare token is active and can use every resource, Access and the zone (read-only probes that name each missing permission). It prints names only, never values. Then `pnpm flags:check`: every flag the code reads is defined in the Flagship app `mimic` and evaluates to a value the code accepts (ADR-0051). |
| Resources | Finds or creates D1 `mimic-prod`, KV `mimic-cache-prod`, R2 `mimic-blobs-prod`, queues `mimic-jobs-prod`, `mimic-identity-prod` and `mimic-jobs-prod-dlq`, and Vectorize `mimic-qa-prod` (768-d cosine, metadata indexes `mimicId` and `kind`). It writes `apps/*/wrangler.deploy.jsonc` with the real IDs and the settings; that file is gitignored. |
| Migrations | `wrangler d1 migrations apply DB --remote`, run before any code that expects the new schema. |
| Worker | Deploys `mimic-worker-prod` (the queue consumer and cron) with its secrets via `--secrets-file`: `OPENROUTER_API_KEY` plus the chosen providers' keys. |
| Web | Runs the OpenNext build with `SITE_URL` set to the environment's origin (the custom domain, or the `workers.dev` URL for preview), which link previews are built against. Then it deploys `mimic-web-prod` with its secrets and the custom domain. The domain's DNS record and certificate are created by Cloudflare. |
| Access | Creates the Access application "Mimic lab" on `/lab`, `/lab/*`, `/api/lab` and `/api/lab/*`, with an allow policy for `ADMIN_EMAILS`. |
| Smoke | Checks that `/` renders, that its `og:image` is a PNG served on the same host, that `/api/health` passes (D1 read, R2 write, no-op job), and that `/lab` redirects to Access. It retries for about 5 minutes while a new domain and certificate come up. |

Secrets are pushed with the code on every deploy, so Doppler stays the source of truth. A value changed in Doppler
syncs to GitHub and reaches the Workers on the next deploy; to apply it right away, run CD by hand (Actions → CD →
"Run workflow" on `main`).

## One-time setup

These are the only manual steps.

1. **Zero Trust.** If the Cloudflare account has never used Zero Trust, open Zero Trust in the dashboard once and
   pick a team name (the free plan is enough). The deploy creates the Access app and policy itself.
2. **Cloudflare API token.** Create an account API token with these permissions:
   - Account:
     - Workers Scripts: Edit
     - D1: Edit
     - Workers KV Storage: Edit
     - Workers R2 Storage: Edit
     - Queues: Edit
     - Vectorize: Edit
     - Access: Apps and Policies: Edit
     - Flagship App · Read and Evaluate on the app `mimic` (ADR-0051). The flags check in preflight and in the Flags
       workflow uses them. Edit is not needed: flags are made in the dashboard, or with `pnpm flags:check
       --create-missing` from a token that has it.
   - Zone `punitarani.com` (or all zones):
     - Workers Routes: Edit. A Custom Domain needs only this and Workers Scripts; Cloudflare creates the DNS record
       and certificate itself.

   Nothing else is needed (Pages, Containers, Tail and the like can be left off).
3. **Doppler → GitHub.** In project `mimic`, config `prd`, set the variables below. Sync them to this repository's
   Actions secrets with Doppler's GitHub integration. CD reads repository secrets and nothing else.

Required:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID (dashboard → Workers & Pages, right sidebar) |
| `APP_URL` | `https://mimic.punitarani.com` |
| `OPENROUTER_API_KEY` | An OpenRouter key |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `INVITE_CODES` | Comma-separated invite codes for the cohort |
| `ADMIN_EMAILS` | Comma-separated emails allowed into `/lab` (the Access policy and the in-app check both use it) |

Settings (optional; each unset one keeps its default: the provider settings in `apps/worker/wrangler.jsonc`, the
`BUDGET_*` ones in code, `packages/core/src/config.ts`), and the key each choice needs:

| Name | Allowed | Default | Needs |
| --- | --- | --- | --- |
| `SEARCH_PROVIDER` | `exa`, `perplexity`, `none` | `exa` | `EXA_API_KEY` for `exa`; `PERPLEXITY_API_KEY` for `perplexity` |
| `ENRICH_PROVIDER` | `exa`, `parallel`, `none` | `exa` | `EXA_API_KEY` for `exa`, `PARALLEL_API_KEY` for `parallel` |
| `EMBEDDINGS_PROVIDER` | `workers-ai`, `openrouter` | `workers-ai` | — (the same 768-d bge-base model either way) |
| `VECTOR_BACKEND` | `vectorize`, `sql` | `vectorize` | — |
| `BUDGET_USD` | A number of US dollars above 0 | `1` | — (the spend cap per mimic on the standard budget; ADR-0035) |
| `BUDGET_SESSION_SHARE` | A number above 0, at most 1 | `0.8` | — (the session's share of the cap; the rest is for the mimic page) |

In prod, the Flagship flags `search-provider`, `enrich-provider`, `embeddings-provider`, `budget-usd` and
`budget-session-share` override these at runtime, with no redeploy (ADR-0051, docs/CHALLENGER.md). The settings stay
as the fallback. A provider flag takes effect only if that provider's key was deployed, so every provider key set in
Doppler is pushed, chosen or not. `VECTOR_BACKEND` has no flag: it picks where the vectors are stored.

Fixtures and the hash embedder are for tests only, so preflight refuses them. Doppler's own metadata
(`DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`, `DOPPLER_PROJECT`) and any other synced names are ignored. A value moves
through GitHub → the step's environment → the Workers and is never printed; GitHub masks it in logs anyway.

## Observability

Both Workers keep logs and automatic traces (ADR-0023). Find them in the Cloudflare dashboard under Workers &
Pages → `mimic-web-prod` or `mimic-worker-prod` → Observability. A trace follows one request, queue batch or cron
run through its D1, KV, R2, queue and outbound fetch calls. Every invocation is sampled; to sample less, lower
`head_sampling_rate` in the `observability` block of each `wrangler.jsonc`.

## Other commands

```
pnpm deploy:dry-run                              # what CI's build job runs: OpenNext build + wrangler --dry-run
doppler run -- pnpm deploy:preflight             # the preflight checks only
doppler run -- pnpm deploy:config --env prod     # write wrangler.deploy.jsonc without deploying
doppler run --config stg -- pnpm deploy:preview  # preview, from a Doppler config of your choice
doppler run -- pnpm backfill --predictor llm:<vendor>/<model> --env prod [--yes]  # new predictor (ADR-0024, ADR-0037)
doppler run -- pnpm relabel:predictors --env prod [--yes] [--reverse]  # stored jev: IDs → decision: (ADR-0054)
doppler run -- pnpm flags:check                  # the Flagship app against the flag registry (also CI's Flags workflow)
```

To backfill a new predictor on prod without local credentials, open Actions → Backfill → Run workflow. It runs the
same script with the repository secrets and is a dry run unless "enqueue" is checked. Predictions run at "rate" a
minute (default 30), and "retry failed" also redoes failed calls, such as rate limits and provider errors (ADR-0037).

### Relabel predictor IDs (ADR-0054)

The deploy that ships ADR-0054 renames the decision predictor kind from `jev:` to `decision:` in code. Rows stored
before it still say `jev:` (the code reads them as `decision:`), and span-01 answers served behind the
`decisions-model` flag carry Jev's ID. Relabel them once that deploy is done:

1. Wait for CD to finish green: the old web app keeps writing `jev:` until its deploy completes. Don't run Backfill
   or Relabel while CD is running.
2. Actions → **Relabel predictors** → Run workflow (a dry run). It counts the `jev:` rows by role (and the newest, so
   a row written after the deploy stands out), shadows stored under both spellings, span-01 answers under Jev's ID,
   and any snapshot it won't touch.
3. Run it again with **apply**, then a dry run once more: every count should be 0. It is safe to re-run.
4. Check in the D1 console that `SELECT COUNT(*) FROM predictions WHERE substr(predictor_id, 1, 4) = 'jev:'` is 0,
   and that `/lab` lists no `jev:` predictor.

Configs keep `jev:` (they are hashed; the code reads it as `decision:`), and job keys, eval reports and `model_calls`
are left as they are. To roll the code back, revert, let CD finish, then run the workflow with **reverse** and
**apply**: the old code can't read `decision:`. Job keys stay as they are, so a reverse run also counts the jobs keyed
`decision:` still queued (a decision backfill in progress): the old code fails them, and a backfill re-run with `jev:`
redoes them. Locally the same script runs as `pnpm relabel:predictors` against the `pnpm dev` database.

`deploy:config` is needed before the eval CLI's remote commands, `pnpm eval -- export --env prod` and
`report --to prod`, because the checked-in configs hold `REPLACE_ME_*` placeholders instead of resource IDs.

## Preview

Preview has its own resources (`mimic-*-preview`) and is served on `workers.dev`. It has no custom domain, and so
no Access in front and no smoke test. Its lab is closed: `ADMIN_EMAILS` isn't pushed to it, because on `workers.dev`
the Access email header could be forged. CD deploys prod only; deploy preview by hand when you need it.

## Limits

- `/api/health` writes a small R2 blob and enqueues a no-op job on every call, including the smoke test's.
- The lab trusts the `cf-access-authenticated-user-email` header. In prod, only Access-protected paths read it, and
  the web Worker has no other URL (`workers_dev` and `preview_urls` are off). The Access JWT itself is not
  re-verified in the app.
- A Vectorize index's shape can't change. If `mimic-qa-prod` exists with other dimensions or another metric, the
  deploy stops and tells you, rather than deleting it.
