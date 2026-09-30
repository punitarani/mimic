# Deploying Mimic

Production is https://mimic.punitarani.com. It is deployed by `.github/workflows/cd.yml` after CI goes green on
`main`, and by nothing else. There is one command, the same locally and in CI:

```
doppler run -- pnpm deploy:prod
```

The command runs `scripts/deploy/deploy.mjs`. Every step is idempotent, so a re-run is always safe:

| Step | What it does |
| --- | --- |
| Preflight | Checks that every name below is set, that `APP_URL` is the custom domain, and that the Cloudflare token is active. It prints names only, never values. |
| Resources | Finds or creates D1 `mimic-prod`, KV `mimic-cache-prod`, R2 `mimic-blobs-prod`, queues `mimic-jobs-prod` and `mimic-jobs-prod-dlq`, and Vectorize `mimic-qa-prod` (768-d cosine, metadata indexes `mimicId` and `kind`). It writes `apps/*/wrangler.deploy.jsonc` with the real IDs; that file is gitignored. |
| Migrations | `wrangler d1 migrations apply DB --remote`, run before any code that expects the new schema. |
| Worker | Deploys `mimic-worker-prod` (the queue consumer and cron) with its secrets via `--secrets-file`. |
| Web | Runs the OpenNext build, then deploys `mimic-web-prod` with its secrets and the custom domain. The domain's DNS record and certificate are created by Cloudflare. |
| Access | Creates the Access application "Mimic lab" on `/lab`, `/lab/*`, `/api/lab` and `/api/lab/*`, with an allow policy for `ADMIN_EMAILS`. |
| Smoke | Checks that `/` renders, that `/api/health` passes (D1 read, R2 write, no-op job), and that `/lab` redirects to Access. It retries for about 2 minutes while the domain comes up. |

Secrets are pushed with the code on every deploy, so Doppler stays the source of truth. A value changed in Doppler
reaches the Workers on the next deploy; to apply it right away, re-run CD with "Run workflow".

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
   - Zone `punitarani.com`:
     - Workers Routes: Edit
     - DNS: Edit
3. **Doppler.** In project `mimic`, config `prd`, set the variables in the table below.
4. **GitHub.** Create a Doppler service token for `mimic/prd`. Then, in the repo under Settings → Environments, create
   the `production` environment and add that token as the secret `DOPPLER_TOKEN`. It is the only GitHub secret.

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID (dashboard → Workers & Pages, right sidebar) |
| `APP_URL` | `https://mimic.punitarani.com` |
| `OPENROUTER_API_KEY` | An OpenRouter key |
| `EXA_API_KEY` | An Exa key |
| `PARALLEL_API_KEY` | A Parallel key |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `INVITE_CODES` | Comma-separated invite codes for the cohort |
| `ADMIN_EMAILS` | Comma-separated emails allowed into `/lab` (the Access policy and the in-app check both use it) |

Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. Everything else is pushed
to the Workers that list it in `secrets.required` in their `wrangler.jsonc`. Doppler variables that no Worker lists
are ignored.

## Other commands

```
doppler run -- pnpm deploy:preflight             # the preflight checks only
doppler run -- pnpm deploy:config --env prod     # write wrangler.deploy.jsonc without deploying
doppler run --config stg -- pnpm deploy:preview  # preview, from a Doppler config of your choice
```

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
