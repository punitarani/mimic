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
- Feedback (ADR-0027), `packages/eval/test/artifact.test.ts`: stored as `kind = feedback` in one write, idempotent
  per key, no predictions or scores, fidelity and progress untouched, learned and included in the next sealed state,
  kept in the export. Validation gives sentences a person can act on. A feedback write and a concurrent `/next` get
  distinct seqs. That test caught a real race: `/next` lost its seq to the feedback and returned a 409, and now it
  re-serves on a fresh state.
- Browser, live providers: 3 answers → write a question by hand → answer it myself (keyboard 1 and Enter, with a
  reason) → scenario → DeepSeek drafts a scale question → Jev predicts → leave it → answer it later from the
  history → mobile and dark. In D1, the next session question's primary has `evidence_seq_max` equal to the
  feedback's seq, and the worker ran `embed.qa` and `traits.read` on each taught answer.

## M7 Eval CLI

Local dev data. Answers came from a scripted rule-based answerer, not people, so the accuracy numbers below validate
the pipeline only and are not research results.

- `export --env local`: kept 4 consented mimics and dropped 8 without research consent. The scrubbed file contains no
  name, location or original mimic ID (byte search of the SQLite file); IDs are `m_…`/`p_…` hashes.
- `replay --mode online` on a `--keep-identity` export, live Jev:

  | | |
  | --- | --- |
  | Primary predictions | 60 (32 pinned by `stateAt`, 28 legacy, 0 over budget) |
  | State hash match (pinned) | 100% (32/32); 14 of 16 states per person carried traits, 7–8 carried insights |
  | Model snapshot match | 100% |
  | Argmax agreement | 95% |
  | Mean TVD / p95 | 0.043 / 0.090 |
  | Accuracy online → replay | 45.7% → 48.0% (mean \|Δ item accuracy\| 0.025 ≤ 0.05) |
  | Verdict | pass |

  Before ADR-0017, the same check rebuilt only 22 of 28 states: traits written while `/next` was running leaked into
  the rebuild. Jev isn't bit-for-bit deterministic (see M5), so scores are compared within a tolerance.
- Checkpoint replay (k = 4, 8, 12; 4 people): primary vs context-only baseline, fidelity and failure rates per
  checkpoint, at $0.0004 per person.
- `report --to local` publishes the run to `eval_runs` and R2. `/lab` lists it and `/lab/evals/[id]` renders the
  report (screenshots `m7-lab-evals.png`, `m7-reproduce.png`, `m7-replay.png`).
- Tests (`packages/eval/test/eval.test.ts`, offline):
  - Reproduction holds under an injected mid-serve trait write.
  - Checkpoint replay covers the baseline, fidelity and across-person metrics.
  - Selection simulation per budget.
  - Dataset hash is stable across recorded runs.
  - Export scrubbing.
  - Twin item mapping, plus import and held-out replay.

  Seeded IDs make the cohort tests deterministic; the across-person test had been flaky because random mimic IDs
  set the anchor order.
- Found and fixed along the way: the local cron never ran in dev (ADR-0019), and the dataset hash drifted as eval
  runs were recorded (ADR-0018).

## M8 Experiments and BALD

- In the browser (`docs/media/m8-create-experiment.webm`, `m8-experiment-created.png`), `/lab`:
  1. derived `cfg.bald.v1` from the default config (selector `bald`, K = 4);
  2. started the two-arm experiment "E3 selector: entropy vs BALD" (weights 1:1).
- Four research-consented dev mimics ran 20 answers each through the live API. Allocation by `hash(mimicId)` put 2
  in each arm, each with its arm's config:
  - BALD mimics made 36 `select.bald` Jev calls each (9 adaptive selections × K = 4) on hypotheses refreshed after
    reflection, and still exactly one sealed `predict.primary` per question.
  - `/lab` shows per-arm fidelity-vs-questions curves, fidelity per dollar, fidelity at 20, and questions to a
    sustained fidelity of 0.75 (`m8-arms.png`).
  - Cost per mimic: entropy $0.023, BALD $0.033.
  - Answers came from a scripted rule-based answerer, so the arm difference means nothing; this validates the
    machinery only.
- Invariants over all 222 served questions: 0 incomplete, 0 shadow-state mismatches, 0 non-context baselines, 0
  sealing violations.
- Tests (`packages/eval/test/experiments.test.ts`, offline):
  - A two-arm experiment allocates six people across both arms with their configs.
  - BALD runs on hypotheses with separate call attribution and one primary per question.
  - The lab's experiment-scoped arm curves cover ≥ 20 points with fidelity at 20.
  - Unit tests cover the sustained-target metric.
- Found and fixed:
  - Concurrent `snapshot.write` jobs could overwrite a committed snapshot blob. A deterministic race test fails on
    the old keying (ADR-0020).
  - Worker hot reloads in dev left jobs `running` for 30 minutes; the stale window is now 15 minutes.

## Session UI v2 (Claude Design handoff)

Browser runs against `pnpm dev` with live providers (answers chosen by a script; pipeline and UI validation only).
Screenshots are in `docs/screenshots/v2-*.png`; videos are `docs/media/session-v2-desktop.webm` and
`session-v2-mobile.webm`.

- **Desktop (1440 × 900):** each design frame was reproduced:
  - D1 question 1 with the keyboard hint row;
  - D2 idle with the menu open;
  - D3 match and D4 miss reveals, with bars and You/Mimic tags;
  - D5 scale reveal with the expected tick ("Close. Your mimic expected about 4.");
  - D6 learning the basics, with "Your last answer touched";
  - D7 welcome back after a reload;
  - dark theme;
  - P5 info popover (55 ÷ 80 = 68%);
  - the full panel: What changed, Tendencies with "Updated" markers, What it's learned with New washes, facts
    and gaps.
- **Mobile (390 × 844, touch):**
  - M1 idle, laid out bottom-up;
  - M2 reveal, with no Enter hint on Next;
  - M3 menu with Finish for now;
  - M4 bottom sheet at 50%, leading with What changed. M4 was checked on screen, but its screenshot was lost
    before saving.
- **Nothing moves on reveal:** the prompt and options were measured before and after every reveal, with 0 px
  movement over 13 desktop answers (5 of them scales) and 15 mobile answers.
- **Data:** a reason typed before answering is stored with answer 1. With guesses turned off, answer 13 returned
  no reveal and is stored with `revealed_prediction = 0`; the others are stored as 1.
- **Checks:**
  - `pnpm check` passes, including new tests for reveal `dist`, `revealShown` (including idempotent replay) and
    the snapshot's history bands, basics and facet labels.
  - `next build` compiles.
