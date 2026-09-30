#!/usr/bin/env bash
# Creates the Cloudflare resources for one deployed environment (preview or prod) and prints the IDs to paste into
# apps/web/wrangler.jsonc and apps/worker/wrangler.jsonc (replace the REPLACE_ME_* values).
# Requires `wrangler login` (or CLOUDFLARE_API_TOKEN) with Workers, D1, R2, KV, Queues and Vectorize permissions.
set -euo pipefail
ENV="${1:?usage: scripts/provision.sh preview|prod}"
W="pnpm --filter @mimic/worker exec wrangler"

$W d1 create "mimic-$ENV"
$W r2 bucket create "mimic-blobs-$ENV"
$W kv namespace create "mimic-cache-$ENV"
$W queues create "mimic-jobs-$ENV"
$W queues create "mimic-jobs-$ENV-dlq"
# bge-base-en-v1.5 → 768 dimensions, cosine. Metadata indexes so queries can filter by mimic and kind.
$W vectorize create "mimic-qa-$ENV" --dimensions=768 --metric=cosine
$W vectorize create-metadata-index "mimic-qa-$ENV" --property-name=mimicId --type=string
$W vectorize create-metadata-index "mimic-qa-$ENV" --property-name=kind --type=string

echo
echo "Now set secrets for both workers (repeat for mimic-web-$ENV and mimic-worker-$ENV):"
for s in OPENROUTER_API_KEY EXA_API_KEY PARALLEL_API_KEY SESSION_SECRET ADMIN_EMAILS INVITE_CODES; do
  echo "  pnpm --filter @mimic/worker exec wrangler secret put $s --env $ENV"
done
