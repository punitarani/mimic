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
