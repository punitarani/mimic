# Validation log

What was checked for each milestone, how, and the measured results. Local numbers come from `pnpm dev` in the Claude
Code remote environment, where every provider call goes through a local egress relay and an outbound proxy
(ADR-0002). Deployed numbers still need a Cloudflare account (see "Not yet verified").

## M0 Scaffold

- `pnpm dev` starts the egress relay, the worker (`wrangler dev`) and the web app (`next dev`).
- `GET /api/health` (web) reads D1, writes R2 and enqueues a `noop` job; the worker consumed it (`job noop:… done`).
- Worker tests (`@cloudflare/vitest-pool-workers`): health route, idempotent queue consumption, malformed messages.

## M1 Adapters and observability

- Offline contract tests against recorded fixtures (13 tests).
- `pnpm test:live`: Jev, OpenRouter chat, embeddings and Exa pass live; Parallel is skipped (host blocked here).
- Budget guard blocks calls at the cap (unit test + real-schema integration test).

## M2 Core engine

- 47 core unit tests: scoring, Jev mapping, config-hash stability (pinned), state budget, sealing, fidelity.
- Offline 30-turn session on the real schema (every table written; sealing re-verified from stored state blobs).
- Live 30-turn CLI session (`pnpm eval -- session --live`): 416 model calls, **$0.09**, zero failed calls.

| Predictor (shadow, live run) | n | mean latency | total cost |
| --- | --- | --- | --- |
| `jev:typesafe/jev-1.13` (primary + baseline) | 56 | 407 ms | $0.0028 |
| `llm:openai/gpt-6-luna` | 28 | 2,041 ms | $0.0071 |
| `llm:deepseek/deepseek-v4.1-flash` | 28 | 4,294 ms | $0.0091 |
| `llm:z-ai/glm-5.3-flash` | 28 | 6,312 ms | $0.0164 |

These are single-session smoke numbers from a scripted user, not research results.

## M3 Intake and identity

- Tests: declining search makes zero search calls; removed facts never appear in any sealed state, prompt or export;
  confirm, skip and "None of these" flows.
- Browser: intake → identity (fixture providers) → confirm → fact review with remove/restore → session.
- Live through `pnpm dev`: web → queue → worker → Exa (2 query variants) → Jev pre-rank → candidates.

## M4 Session and model panel

Playwright against `pnpm dev` (14 answered questions, keyboard only):

| Metric | p50 | p95 |
| --- | --- | --- |
| `/answers` server time | 191 ms | 226 ms |
| `/next` server time | 682 ms | 1,001 ms |
| — of which Jev selection round trip | 461 ms | 707 ms |
| — of which D1 load + persist | 163 ms | 230 ms |
| answer + next, server | 893 ms | 1,106 ms |
| UI answer → next question (includes the 600 ms reveal) | 1,324 ms | 1,535 ms |

- Offline: with the network dropped, the answer was kept in the IndexedDB outbox (1 queued) and arrived after
  reconnecting (answers 14 → 15).
- Refresh: with `/next` delayed by 3 s on the server, the same question rendered from the IndexedDB cache in 886 ms
  (dev-mode page load).
- Keyboard only: intake by typing and Tab; answers with 1–5, Y/N and Enter; "why" via Tab and Ctrl+Enter.

## Not yet verified

- `pnpm deploy:preview` and the preview latency target (answer → next p50 ≤ 800 ms): this environment has no
  Cloudflare account. Locally, the Jev round trip through the relay and proxy is the dominant cost; on Workers the
  D1 phases should also shrink.

## M5 Shadows and lab v0

- `/lab` (admin; open in local dev): per-predictor accuracy, top-1, log loss, Brier, ECE, paired lift over the
  baseline, failures, $/1k and latency; cost and latency per call type; fidelity vs questions per arm; fidelity per
  dollar; configs, experiments and eval runs. Research metrics default to consented mimics.
- The lab doubles as an invariant monitor over every served question: missing primary/baseline/shadows, shadow
  state ≠ primary state, non-context baselines and sealing violations. On local data: 0 state mismatches, 0
  non-context baselines, 0 sealing violations. The only incomplete questions were shadow jobs lost when `pnpm dev`
  was restarted mid-backlog (local queue messages live in memory); a cron sweep now re-enqueues stale jobs.
- Tests: the offline session test asserts 1 primary + 1 context-only baseline + 3 shadows per scored question with
  identical state hashes, and none for repeats.
- Finding: for first questions the sealed state equals the context-only state (same hash), yet Jev returned
  slightly different distributions for the primary and baseline calls. Jev is not bit-for-bit deterministic across
  calls, so M7 replay compares within a tolerance.

## M6 Mimic artifact and playground

- Tests (`packages/eval/test/artifact.test.ts`):
  - Export validates against `mimic/1` (zod; JSON Schema published at `docs/schemas/mimic-1.schema.json`), and
    snapshots are immutable and versioned.
  - Hard delete: before deletion the mimic's ID appears in 50+ rows; afterwards no row in any table, no blob (states,
    snapshots, search payloads, model-call traces) and no KV key (hypotheses, search cache) mentions it, while
    another person's mimic is untouched.
  - Playground: questions and answers are stored as `kind = playground` with sealed primary and baseline
    predictions, scored, excluded from fidelity and from later states, and kept in the export.
- The test caught a real bug: the playground's "generated sentence" flag collided with the draft schema's
  `rationale` field, so asking with a rationale failed. Fixed.
- Browser, live providers: 6 answers → Stop here → scenario → DeepSeek drafts a typed question → Jev predicts
  61% / 39% → generated first-person sentence, labeled → the person answers → download `mimic.json` (`mimic/1`, v2,
  playground evidence included) → delete → `GET /api/mimics/:id` returns 404.
