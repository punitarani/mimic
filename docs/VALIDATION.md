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
- Feedback (ADR-0032), `packages/eval/test/artifact.test.ts`: stored as `kind = feedback` in one write, idempotent
  per key, no predictions or scores, fidelity and progress untouched, learned and included in the next sealed state,
  kept in the export. Validation gives sentences a person can act on. A feedback write and a concurrent `/next` get
  distinct seqs. That test caught a real race: `/next` lost its seq to the feedback and returned a 409. Now it keeps
  its predictions and serves at the next free seq.
- Review follow-up, `packages/eval/test/feedback.test.ts`:
  - Feedback given while a session question is open takes its seq, and the question moves. `/next` returns it at
    the new seq. Answers are learned in seq order. Replay rebuilds the moved question's state to the same hash.
  - An answer that raced the move is recorded at the new seq.
  - A reused key with a different answer is refused. Yes/no maps by key in any order.
  - Over budget, feedback is kept, with no model calls or failed jobs, and is in the snapshot.
  - An asked question that loses its seq to feedback is served at the next one without predicting again, and
    leaves no orphaned row.
  - An answer that arrives below the latest snapshot gets a new snapshot.
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

## Selection v2: value of information (ADR-0027)

Offline fakes only (deterministic; outputs are arbitrary), so nothing below is a research result. It validates the
machinery: `pnpm check` passes with 74 core unit tests and 41 eval integration tests.

- Unit tests (`packages/core/test/belief.test.ts`, `selection.test.ts`, `state.test.ts`): the belief state's
  uncertainty, conflict (method gap, superseded insights, repeat flips, torn answers), shrunk weakness, coverage,
  exposure, domain shares, speeding and straightlining; generator targets and the tilted domain quota; the
  hypothesis posterior and weighted mutual information; burden; the `voi` selector's pick with and without
  hypotheses, exposure control, population and belief terms, and its failure fallback; item statistics with no
  per-person data, shrinkage and the people threshold; latency hints (builder `full.v2`, median over the sealed
  evidence, no hints below three timed answers, context-only untouched). Config hashes: v4 pinned, v3 unchanged.
- Integration (`packages/eval/test/selection.test.ts`, 7 people × 24 turns plus one late-comer): every adaptive
  question served by `voi` records its score components; each hypothesis prediction of the chosen question is
  stored, sealed (`evidence_seq_max < seq`), never scored, and rebuilds from its state blob; posterior weights
  move away from uniform once answers arrive; sealed states use `full.v2` and baselines stay context-only;
  `stats.refresh` aggregates consented dev-split mimics with no names or IDs in any row, is idempotent, and a
  session served afterwards carries a population term; `gen.v2` candidates and their calls are logged.
- The existing 30-turn session test still holds: 1 primary, 1 context-only baseline and 5 shadows per scored
  question sharing one state hash, none for repeats, 28 × 7 scored rows, 30 fidelity rows.
- Not yet measured: E3 arms `entropy` vs `voi` on real people, and `pnpm eval -- select --selector entropy,voi`
  on a real export. Both need human answers.

## Evals and prompt optimization (ADR-0028)

Checked in the Claude Code environment. Prod data isn't reachable here, so the live runs used two scripted live
sessions: 17 answered questions, with one dev person and one test person. The metrics below validate the machinery
only; scripted answers say nothing about real people. The whole live smoke cost **$0.20**.

- **Offline** (fake providers, 7 scripted people, 161 instances):
  - every command runs end to end: `evaluate --from stored`, live-mode `evaluate` with `--repeat`, `diagnose` and
    `optimize`;
  - the fake Jev ignores its templates, so the optimizer rejects every child, as it should.
- **Tests** (`packages/eval/test/optimize.test.ts`, `packages/core/test/components.test.ts`):
  - the incumbent prompts render byte for byte as before;
  - `@version` IDs parse, resolve and are rejected when unregistered, or when they name the incumbent;
  - instances are sealed, and test people never reach train or val;
  - stored records, fits and feedback;
  - candidate caching and the spend cap;
  - the leakage lint;
  - the reflection repair turn;
  - a full GEPA run that accepts an improving child, passes the holdout and resumes;
  - the call-budget stop;
  - Pareto sampling;
  - report rendering with no question text in it.
- **Live, every command:**

  | Run | Calls | Cost | Result |
  | --- | --- | --- | --- |
  | `evaluate --from stored` | 0 | $0 | Seven predictors per split, person and type |
  | `optimize`, Jev templates, 4 iterations | 44 | $0.033 | 1 invalid (133 words over the 120 limit), 2 rejected, 1 accepted on its minibatch but worse on val; verdict "no candidate beat the seed" |
  | `optimize`, DeepSeek prompt, 3 iterations | 35 | $0.044 | 3 rejected under the noise margin |
  | `evaluate`, `probs` vs `reasoned` schema, `--repeat` | 39 | $0.013 | Paired comparison and noise floor |
  | `diagnose`, Jev primary | 1 | $0.035 | Overconfident peaks on thin evidence (100% on a miss, log loss 9.2), and drift away from a correct profile-only guess |

- **Findings that shape how to use it:**
  - Run-to-run noise per question is 0.031 nats for Jev and 0.14–0.20 for DeepSeek V4.1 Flash. LLM prompt changes
    therefore need about 5× the validation size to show the same gain, and Jev is the cheaper, more sensitive target.
  - A Sonnet 5.5 reflection costs $0.007–0.011, so a 30-iteration Jev run costs well under $1.
  - The accepted reflection was general strategy with no copied data: weigh direct earlier answers, cap confidence
    on thin evidence, leave mass on adjacent scale points. The lint passed it.
  - A reflection over the word limit wasted an iteration, so the loop now gives a rejected reflection one repair
    turn naming its problems.
- **Not verified here:**
  - the Actions workflow's prod export and `/lab` publishing, which need the Cloudflare credentials in the
    production environment;
  - its Twin-2K-500 step, since Hugging Face is blocked in this environment. That step is best-effort, and the run
    continues without it.

## M9: categories, consent and scoped facets (ADR-0040)

Offline fakes only (deterministic; the generator tags whatever it is told to target), so nothing below is a research
result. It validates the machinery. Scripted people now carry a `script:` participant id.

- Unit tests (`packages/core/test/scope.test.ts`, 9 tests): the allowance truth table (category, sensitive area,
  consent), normalisation (canonical order, consents dropped with their category, research consents only with the
  area's consent and research consent overall), `scopeShrank`, the scope view on mixed-facet, pooled, unknown-facet
  and sensitive questions, hidden insights and reflection facts, `validateDraft` rejecting blocked tags, every v1
  facet categorised, and the special-category fact lexicon (hits: church choir, Sunday mass, a party campaign,
  diabetes advocacy, a cancer survivor headline, an LGBTQ+ network; misses: trail running, Temple University, an
  employer in mental health, an oncology nurse title, "democratic decision-making").
- Integration (`packages/eval/test/scope.test.ts`, 2 people × 20 turns with only psychology and values, 1 person × 22
  turns with every category):
  - seven anchors seeded instead of ten, in the same per-person order;
  - no served question, trait history row, insight, knowledge-graph facet node, snapshot facet or occupation facet
    touches "Relationships, sexuality and life" or "Work and money";
  - no generator call lists a blocked facet in its ontology block or targets, and no trait read asks about one
    (read from the model-call traces);
  - narrowing the scope mid-session discards the out-of-scope pool, stamps `scope_at`, hides the answered work
    anchor from the loaded view while keeping its rows, and nothing from the withdrawn category is served in the next
    ten questions; widening back stamps nothing.
- Every existing suite passes unchanged under the default scope (core, db, eval, worker, web), including the offline
  online-reproduction test (`eval.test.ts`), so default-scope state hashes are unchanged. Config hashes v1–v4 are
  unchanged (no config change in M9).
- Not measured: anything about real people; the UI (M11); sensitive facets (they arrive with ontology v2 in M10).

## Reasoning budgets per model and calibrated Jev (ADR-0041)

Checked in the Claude Code environment on states from two scripted 72-turn sessions. These runs measure token use,
failures and cost, and say nothing about accuracy. Everything live, probe included, cost about $0.70.

- **Probe:** 8 long states per model and setting (seq 45 to 72), with an 8,000-token cap so nothing truncated. The
  table in ADR-0041 has the numbers. Medium effort bought nothing over low. Qwen Flash ignores effort, and a
  1,024-token budget was the smallest that kept every answer valid.
- **End to end, first round:** `pnpm eval -- evaluate --predictor <shadow>` ran over 120 states for each shadow,
  and for Jev with and without calibration. There were 8 failures in 720 calls:
  - DeepSeek reached 3,094 completion tokens, which is past the old 3,000 cap.
  - GLM truncated once, with its reasoning running to the first 1,500 cap.
  - Qwen seven times, and GLM once, keyed a 0–4 scale by its labels.

  This led to raising the DeepSeek and GLM caps and adding label re-keying.
- **Second round, Qwen and GLM:** one failure each in 120.
  - GLM reasoned past the 1,500 cap once more. That run used the old cap, before it was raised to 3,000.
  - Qwen fell into a degenerate list of invented keys that ran to the cap.
- **Final round, after the xhigh review of #18:** the five `predict.v2` shadows, with the option keys as an enum in the schema,
  ran over the same 120 states each. The results, across 602 calls:
  - 0 failures;
  - 0 truncations;
  - 0 keys outside the enum, so every provider enforced it and the label fallback was never needed;
  - largest completions of 259 (Luna), 629 (MiMo), 1,178 (Qwen), 1,380 (GLM) and 2,382 (DeepSeek), each under its cap.

  MiMo had two transient malformed responses from OpenRouter, and the evaluator's single retry recovered both.
- **Live test** (`pnpm test:live -t shadow`): each LLM shadow in `DEFAULT_CONFIG` runs through the real
  `LlmPredictor` (prompt, schema, reasoning control and cap) on a 0–4 scale question. All five pass.
- **Tests:**
  - the adapter sends a budget or an effort, never both, and sends a budget of 0 as 0;
  - `predict.v2` resolves per model and refuses a model it doesn't list, in configs and candidates;
  - every registered variant leaves room for the answer, and a candidate that doesn't is refused;
  - a Qwen `@predict.v2` request carries its budget, cap and key enum, and `predict.v1` requests are unchanged;
  - labels are re-keyed only when they cover every option unambiguously, under `predict.v2` only;
  - calibrated Jev keeps its pick, and noul confidence stays on Jev's scale;
  - the stored report derives calibrated Jev from the primary at no cost, fits report test accuracy, and pools only
    LLM shadows;
  - the optimizer stops at a wall-clock deadline;
  - a winner's snippet scopes reasoning and caps to its model and shares every other setting;
  - the v4 and v5 hashes are unchanged, and v6 is v5 with its LLM shadows on `predict.v2` plus the reasoning-off Qwen
    control;
  - the 30-turn session test runs 1 primary, 1 baseline and 6 shadows per scored question, each recording its
    prompt version.

## M10: ontology v2, reserve.v2, gen.v3 and gates.v3 (ADR-0042)

Three kinds of evidence, kept apart. Nothing below comes from real people, and nothing is a measure of prediction
accuracy.

- **Offline fakes (tests, deterministic).**
  - `packages/core/test/ontology-v2.test.ts` (10 tests): v1 facets unchanged; 34 new facets, each with poles, five
    labels, its group's category and a research anchor; sensitive facets only inside their area's category, with
    every area covered; at least two reserve.v2 items per new facet, each a valid question on known facets, no
    self-rating forms, no "prefer not to say"; gates.v2 word for word unchanged; the sensitive gate asking only
    about untagged areas; `concrete` and `demeaning` failures; unasked gates never fail.
  - `packages/eval/test/generation-v3.test.ts` (7 tests, sessions under the candidate): every generated question
    gated with gates.v3 and its areas recorded; the fakes' self-rating, untagged religious and loaded drafts never
    pooled, and the political one pooled only with politics consented; no sensitive facet without consent; the
    generator shown categories, a quota and only consented sensitive facets; reflect.v2 and hyp.v2 in the traces;
    reserve.v2 carrying a session spread across facets; and an online reproduction at a 100% state-hash match.
  - `packages/eval/test/scope.test.ts`: no workplace scenes without "Work and money".
- **Live gate calibration (hand-labelled questions, live Jev).** `docs/reports/m10-gates.md`: 133 labelled items
  and a 40-item held-out set. Concrete AUC 0.990, sensitive 0.993, demeaning 0.960, leading 0.948. On the held-out
  set 34 of 36 good drafts passed. Labels are the implementer's.
- **Live scripted sessions (a scripted answerer, live generator, gates and selector).**
  `docs/reports/m10-concreteness.md`: 46 of 48 served adaptive questions concrete by hand (96%), 13 of 48 in
  workplace scenes, and no sensitive facet reached by question 30 even with consent (the sweep is M12's).
  Scripted, so not a result about people.

## M11: scope enforcement, direct evidence only, and the consent UI (ADR-0043)

Nothing below comes from real people, and nothing is a measure of prediction accuracy.

- **Offline fakes (tests, deterministic).** The fakes break the rules on purpose: the reflector tags religion and
  states "Sounds deeply religious" from any answers, adds a "Sunday mass" fact, the hypothesis writer guesses church
  attendance, and the generator appends rogue drafts.
  - `packages/eval/test/leakage.test.ts` (10 tests, four cohorts under `cfg.m10.candidate`): without consent no
    sensitive facet is asked, read, reflected, stored or graphed, and none reaches the generator, trait reader or
    reflector prompts; web facts naming a special-category area are never stored; with consent sensitive questions
    are asked, a sensitive trait is read only after a direct question, the reflector's sensitive tags, statements and
    facts survive only with a direct citation, and a religious guess in a hypothesis survives only after a direct
    religion answer; after health is withdrawn nothing more is asked about it, no later sealed state holds it, and
    online reproduction passes with the earlier states reported as `rescoped`; a `--keep-identity` export keeps
    everything, a research export scrubs special categories the person didn't consent to research use of and keeps
    money and everything for the person who did.
  - `packages/core/test/guards.test.ts` (5 tests): the guards' keep and drop paths, and item statistics counting a
    special-category facet only with research consent for it.
  - `packages/eval/test/scope.test.ts`, `packages/core/test/scope.test.ts` (M9, still green),
    `apps/web/lib/scope-form.test.ts` (4 tests: the form reducer matches `normalizeScope`), and an adapters contract
    test that the enrichment schema requests no special-category field.
- **Browser (Playwright against `pnpm dev` with fixture providers).** `scripts/browser/scope.mjs`, 1440×900 and
  390×844, light and dark: every category on and every area off by default; keyboard only (Tab reaches each
  category, Space toggles, a disabled area is skipped and says why); research-use boxes only with research consent,
  one per consented special area; the model panel names the category turned off; the dialog takes focus, Escape
  closes it and returns focus to the More button; a narrowing warns before saving and the session confirms.
  Screenshots: `docs/screenshots/m11-intake-scope.png`, `m11-intake-scope-mobile.png`, `m11-menu-topics.png`,
  `m11-scope-sheet.png`, `m11-scope-sheet-dark.png`.
- **End to end on local dev (fixture providers, a scripted answerer through the HTTP API).** 12 answers, "Relationships,
  sexuality and life" turned off through `PATCH /api/mimics/:id/scope` (1 waiting question discarded), 12 more
  answers. `export --env local --keep-identity` then `replay --mode online`: 23 primaries, 11 checkable, 12
  `rescoped`, state-hash match 1.000, pass. A research export of the same data withheld 7 questions and 33 trait
  rows. Scripted, so a check of the machinery, not a result.
