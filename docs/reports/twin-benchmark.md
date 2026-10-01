# Twin-2K-500 benchmark: states, policies, transfer and evidence (ADR-0056, ADR-0057, ADR-0053, ADR-0062)

A baseline for the research directions in `docs/RESEARCH.md`, run on imported people, not Mimic's. Twin-2K-500
(Toubia et al., 2025, CC BY 4.0) gives each person's answers to waves 1–3 as evidence and their wave 4 answers as
held-out items. Nothing here is a result about a Mimic user, and nothing comes from a scripted or simulated session.

## The run

| | |
| --- | --- |
| Data | 120 people fetched through the Hugging Face datasets server and imported with `pnpm eval -- import twin2k500` into a local store; every run takes the same 60 (`--seed bench --limit 60`) |
| Targets | Every wave 4 item with a typed answer: 3,932 sealed predictions per run and checkpoint, about 66 per person |
| Checkpoints | After k = 10, 30 and 100 wave 1–3 answers, in sequence order; each state is sealed below the checkpoint (`replay --targets heldout`) |
| Primary | `decision:typesafe/jev-1.13`, snapshot `typesafe/jev-1.13-20260917`, on its raw scale (no calibration temperature); log loss and Brier are on that scale, which is why they sit above E6's calibrated numbers |
| Baseline | The same model on the context-only state (identity, no answers), as invariant 6 requires |
| Replay matrix | `full` (the served state: every answer until the §9.9 budget, then anchors + retrieved + recent), `raw`, and `card` (identity + traits + capped answers) under `mixed`, `recent`, `similar` and `surprise` at a cap of 12, and under `surprise` and `recent` at a cap of 6; two passes each, the second with per-question rows for paired comparisons |
| Transfer | `pnpm eval -- transfer` at k = 30, 20 held-out targets per person, six views, with sealed `soul.v1` drafts written by DeepSeek V4.1 Flash; a DeepSeek reader (`predict.v2` settings) on 10 people, a Jev reader on 60 |
| Calibrated | The card and `surprise` cells again with `decision:typesafe/jev-1.13@jev-predict.v2`, one pass with rows |
| E6 | `pnpm eval -- evidence` on the same import at k = 10, 30 and 100 (ADR-0053), Jev calibrated, 20 targets per person |
| Spend | $0.0019–0.0048 per person per replay run (a surprise card needs one baseline prediction per training answer, which is free online where the baseline is always stored), $0.46 for the DeepSeek transfer run, $0.25 for the Jev one, $0.73 for E6; about $4.50 in all |
| Intervals | Paired by question, bootstrapped over people (2,000 resamples, 5th–95th percentile), so that correlated questions within a person do not narrow them |

The commands are in `docs/VALIDATION.md` under this report's heading; report files, rows and traces stay in `data/`
(gitignored).

## What it shows

1. **Answers help Jev on these people, and more with more of them.** Against the context-only baseline, the served
   state lifts item accuracy by +0.5, +3.4 and +7.3 points at k = 10, 30 and 100 (fidelity 72.8% → 80.9%). E6 on the
   same import, with the calibrated primary and 20 targets per person, agrees: +2.7 [+0.4, +5.1] at k = 10,
   +4.0 [+1.3, +6.7] at k = 30, +6.6 [+3.5, +9.6] at k = 100, with 43 of 60 people better on log loss at k = 30.
2. **A 12-answer card matches the served state up to 30 answers at half the tokens, and loses one point at 100.**
   At k = 30 the card is 1,236 tokens against 2,568 and is level on accuracy (+0.6 [−0.7, +2.0] by person); at k = 100
   it is 981 against 1,461 and loses −1.0 [−1.7, −0.3]. The served state at k = 100 is itself a subset: the §9.9 budget
   keeps 18 of the 100 answers. So the question is not "all answers or twelve" but "eighteen chosen by anchors,
   retrieval and recency, or twelve by a policy", and twelve costs about one point.
3. **In this matrix, `mixed`, `recent` and `similar` are the same policy.** They sit within 0.4 points of each other at
   every k, inside the run-to-run noise (0.25 points on average between passes, at most 0.43), and for a reason found
   later: replay built one state for all of a person's targets, with no target to rank against, so `similar` and the
   retrieval half of `mixed` fell back to recency. The "card 12 · similar" rows below measure a recency card. What
   retrieval does is measured per target in "Retrieval per target", below.
4. **`surprise` trades accuracy for calibration.** Keeping the answers the baseline got most wrong costs −1.1 [−2.0,
   −0.4] points at k = 100 but improves raw log loss by −0.088 [−0.120, −0.056] (46 of 60 people better) and Brier
   (0.570 against 0.580). With a cap of 6 the same policy is −0.7 [−1.6, +0.1] points and −0.035 [−0.072, +0.001].
   Every other state gets worse on log loss as k grows (full: 1.128 → 1.281) while accuracy rises: on its raw scale
   Jev grows overconfident with evidence, and a state built from what the stereotype got wrong tempers that. The
   calibrated primary (`@jev-predict.v2`) does most of that job with a temperature: rerun with it and with surprise
   ranked on the raw scale as production ranks it, `surprise` keeps −0.010 [−0.016, −0.004] of log loss at k = 100
   and is worse at k = 30 (+0.023). A first calibrated run ranked surprise on the calibrated scale and showed a large
   dispersion advantage (0.197 against 0.127 at k = 30); with the production ranking it is 0.141. That advantage
   belonged to the ranking, not to the policy.
5. **Six answers are enough early, and the cheapest state is not the worst.** A 6-answer `recent` card is +1.3
   [+0.4, +2.2] points over the full 10-answer state at k = 10 (335 against 534 tokens) and +0.9 [−0.5, +2.3] at k = 30
   (626 against 2,568), then −0.8 [−1.6, +0.0] at k = 100. Its log loss is worse throughout (+0.172 at k = 10). Fewer
   answers make Jev more decisive, which pays on accuracy early and costs on calibration.
6. **Smaller states individuate less, unless they are chosen for the question.** Dispersion (SD of predictions over
   SD of answers, across people) is 0.42 for the served state at k = 30 and 0.28 for every card; across-person
   correlation stays at 0.20–0.24 everywhere. The exception is a card retrieved per question by embeddings (below):
   eight answers, and the highest dispersion of any state at k = 100.
   Accuracy did not move, so the card loses spread, not rank order. The mega-study of digital twins found that
   personal data shows up in dispersion before accuracy, which makes this the metric to watch when a compressed
   state looks "level".
7. **What transfers is the answers, and the format they come in.** A DeepSeek reader that knows nothing of Mimic
   (10 people, 200 targets, k = 30) gets 59.4% from the state text, 54.2% from the card (−5.2), 53.7% from
   `mimic.json` (−5.7), 53.4% from the full SOUL.md (−6.0), 49.2% from the core SOUL.md (−10.2) and 48.3% from
   identity alone. The core profile (facts, traits and a narrative, no answers) is worth about one point over
   nothing. The full SOUL.md carries the same answers as the state and is twice its size (4,270 against 2,192
   tokens), and still loses six points: prose around the evidence costs this reader accuracy. Ten people give
   intervals of roughly ±6 points, so only the ordering state > answers-bearing views > core > context is firm.
8. **Jev reads a summary better than the answers it was written from.** The Jev reader on 60 people gets 61.9% from
   the state text and 65.6% from the core SOUL.md, which holds DeepSeek's narrative of the same 30 answers and no
   answers at all, at a large log-loss cost (1.582 against 1.071). E6 saw the same on served questions (`derived`
   +4.8 points for Jev, no log-loss gain). An LLM doing the inference and Jev reading its conclusion is a pipeline
   worth testing as a served shadow, with its own calibration.
9. **The lift is transfer between domains, and what the state keeps decides which.** No held-out domain appears in
   the first 100 answers. Party and ideology carry the policy items while the state holds them (+4.4) and not once
   recency has dropped them (+1.2); materialism rows carry the product items (+11.5 at k = 100). Probability tasks
   get the same prediction whatever the state. Lexical similarity does not find these links, so a similarity-based
   state policy or retrieval cannot either.

## Replay matrix, second pass (60 people, 3,932 predictions per cell)

Lift is against the baseline in points of item accuracy; fidelity is accuracy over the people's own test-retest
consistency.

| State | k | Accuracy | Top-1 | Log loss | Brier | ECE | Lift | Fidelity | Dispersion | $/person |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (context only) | – | 59.2% | 51.1% | 1.199 | 0.628 | 0.218 | — | — | — | — |
| full (served) | 10 | 59.7% | 54.0% | 1.128 | 0.587 | 0.186 | +0.5 | 72.8% | 0.400 | $0.0023 |
| full (served) | 30 | 62.5% | 57.0% | 1.156 | 0.566 | 0.167 | +3.4 | 76.3% | 0.416 | $0.0023 |
| full (served) | 100 | 66.5% | 58.5% | 1.281 | 0.580 | 0.135 | +7.3 | 80.9% | 0.256 | $0.0023 |
| raw | 10 | 59.8% | 54.1% | 1.128 | 0.587 | 0.184 | +0.6 | 73.0% | 0.401 | $0.0023 |
| raw | 30 | 62.3% | 56.7% | 1.156 | 0.566 | 0.168 | +3.1 | 76.0% | 0.415 | $0.0023 |
| raw | 100 | 66.1% | 58.2% | 1.286 | 0.580 | 0.138 | +7.0 | 80.5% | 0.256 | $0.0023 |
| card 12 · mixed | 10 | 59.7% | 54.1% | 1.131 | 0.587 | 0.186 | +0.5 | 72.9% | 0.401 | $0.0021 |
| card 12 · mixed | 30 | 63.1% | 55.2% | 1.233 | 0.584 | 0.173 | +4.0 | 77.1% | 0.285 | $0.0021 |
| card 12 · mixed | 100 | 65.5% | 57.4% | 1.305 | 0.589 | 0.142 | +6.3 | 79.8% | 0.241 | $0.0021 |
| card 12 · recent | 10 | 59.7% | 54.0% | 1.132 | 0.588 | 0.186 | +0.2 | 72.9% | 0.399 | $0.0021 |
| card 12 · recent | 30 | 63.0% | 55.0% | 1.224 | 0.585 | 0.171 | +3.5 | 77.0% | 0.284 | $0.0021 |
| card 12 · recent | 100 | 65.6% | 57.6% | 1.309 | 0.588 | 0.141 | +6.1 | 80.0% | 0.242 | $0.0021 |
| card 12 · similar | 10 | 60.1% | 54.4% | 1.140 | 0.587 | 0.183 | +0.9 | 73.3% | 0.400 | $0.0021 |
| card 12 · similar | 30 | 63.2% | 55.3% | 1.229 | 0.583 | 0.170 | +4.0 | 77.3% | 0.285 | $0.0021 |
| card 12 · similar | 100 | 66.0% | 57.9% | 1.309 | 0.588 | 0.137 | +6.8 | 80.4% | 0.241 | $0.0021 |
| card 12 · surprise | 10 | 59.7% | 54.1% | 1.139 | 0.588 | 0.186 | +0.4 | 73.0% | 0.401 | $0.0048 |
| card 12 · surprise | 30 | 62.5% | 54.7% | 1.214 | 0.585 | 0.167 | +3.1 | 76.4% | 0.303 | $0.0048 |
| card 12 · surprise | 100 | 65.3% | 57.2% | 1.192 | 0.570 | 0.135 | +5.9 | 79.6% | 0.257 | $0.0048 |
| card 6 · surprise | 10 | 60.4% | 55.2% | 1.178 | 0.577 | 0.180 | +1.0 | 73.6% | 0.426 | $0.0047 |
| card 6 · surprise | 30 | 62.9% | 55.2% | 1.169 | 0.577 | 0.158 | +3.5 | 76.9% | 0.283 | $0.0047 |
| card 6 · surprise | 100 | 65.7% | 57.8% | 1.246 | 0.570 | 0.128 | +6.3 | 80.1% | 0.248 | $0.0047 |
| card 6 · recent | 10 | 60.9% | 55.5% | 1.299 | 0.600 | 0.182 | +1.8 | 74.4% | 0.425 | $0.0019 |
| card 6 · recent | 30 | 63.5% | 55.5% | 1.228 | 0.583 | 0.162 | +4.4 | 77.6% | 0.279 | $0.0019 |
| card 6 · recent | 100 | 65.7% | 57.5% | 1.326 | 0.591 | 0.144 | +6.6 | 80.0% | 0.238 | $0.0019 |

The baseline row is the first pass's; the second pass's baseline is within 0.2 points of it at every cell.

### Against the served state, paired by question, intervals over people

| State | k | Δ accuracy (points) [90% CI] | Δ log loss [90% CI] | People better / worse (log loss) |
| --- | --- | --- | --- | --- |
| raw | 10 | +0.1 [−0.3, +0.6] | +0.000 [−0.012, +0.012] | 27 / 33 |
| raw | 30 | −0.3 [−0.7, +0.2] | −0.001 [−0.011, +0.010] | 31 / 29 |
| raw | 100 | −0.3 [−0.8, +0.1] | +0.005 [−0.006, +0.017] | 26 / 34 |
| card 12 · mixed | 10 | +0.0 [−0.5, +0.5] | +0.004 [−0.007, +0.015] | 26 / 34 |
| card 12 · mixed | 30 | +0.6 [−0.7, +2.0] | +0.078 [−0.012, +0.167] | 28 / 32 |
| card 12 · mixed | 100 | −1.0 [−1.7, −0.3] | +0.023 [−0.004, +0.050] | 25 / 35 |
| card 12 · recent | 10 | −0.0 [−0.4, +0.4] | +0.004 [−0.006, +0.014] | 28 / 32 |
| card 12 · recent | 30 | +0.4 [−1.0, +1.9] | +0.069 [−0.023, +0.160] | 29 / 31 |
| card 12 · recent | 100 | −0.8 [−1.6, −0.1] | +0.027 [−0.000, +0.055] | 21 / 39 |
| card 12 · similar | 10 | +0.4 [−0.1, +0.9] | +0.012 [−0.000, +0.024] | 28 / 32 |
| card 12 · similar | 30 | +0.6 [−0.7, +2.0] | +0.074 [−0.015, +0.163] | 29 / 31 |
| card 12 · similar | 100 | −0.5 [−1.2, +0.2] | +0.027 [+0.002, +0.053] | 21 / 39 |
| card 12 · surprise | 10 | +0.1 [−0.4, +0.5] | +0.011 [−0.002, +0.024] | 21 / 39 |
| card 12 · surprise | 30 | −0.1 [−1.4, +1.2] | +0.060 [−0.024, +0.143] | 28 / 32 |
| card 12 · surprise | 100 | −1.1 [−2.0, −0.4] | −0.088 [−0.120, −0.056] | 46 / 14 |
| card 6 · surprise | 10 | +0.7 [−0.1, +1.5] | +0.050 [+0.015, +0.083] | 23 / 37 |
| card 6 · surprise | 30 | +0.4 [−1.2, +1.9] | +0.015 [−0.069, +0.102] | 31 / 29 |
| card 6 · surprise | 100 | −0.7 [−1.6, +0.1] | −0.035 [−0.072, +0.001] | 33 / 27 |
| card 6 · recent | 10 | +1.3 [+0.4, +2.2] | +0.172 [+0.127, +0.219] | 14 / 46 |
| card 6 · recent | 30 | +0.9 [−0.5, +2.3] | +0.073 [−0.012, +0.156] | 30 / 30 |
| card 6 · recent | 100 | −0.8 [−1.6, +0.0] | +0.045 [+0.012, +0.079] | 22 / 38 |

Intervals by question instead of by person are about half as wide and reach the same signs.

### State sizes (mean over the 60 people, no model calls)

| State | k = 10 | k = 30 | k = 100 |
| --- | --- | --- | --- |
| context | 19 tokens, 0 answers | 19, 0 | 19, 0 |
| full (served) | 534, 10 | 2,568, 30 | 1,461, 18 |
| raw | 534, 10 | 2,568, 30 | 1,461, 18 |
| card 12 | 534, 10 | 1,236, 12 | 981, 12 |
| card 6 | 335, 6 | 626, 6 | 501, 6 |
| E6 `relevant` (8 answers nearest the question) | 443, 8 | 774, 8 | 652, 8 |

### Run-to-run noise

The first and second pass of each spec are independent runs of the same calls. Over the 18 cells (six specs × three
checkpoints) accuracy differs by 0.25 points on average and 0.43 at most; log loss by 0.008 on average and 0.025 at
most. A difference under half a point between two single runs is noise.

## Transfer loss at k = 30 (ADR-0057)

Transfer loss is the `state` view's accuracy with the same reader minus the view's: what reading the export instead
of the live state costs. Lift is against `context` (identity only) with the same reader.

### DeepSeek V4.1 Flash reader, 10 people, 200 targets (`transfer.v1`, `predict.v2` settings)

| View | Tokens | Accuracy | Top-1 | Log loss | Brier | ECE | Lift | Transfer loss | $/1k |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| context | 13 | 48.3% | 40.5% | 0.907 | 0.571 | 0.024 | — | +11.1 | $0.093 |
| state | 2,192 | 59.4% | 56.5% | 0.772 | 0.479 | 0.079 | +11.1 | — | $0.417 |
| card (12, surprise) | 941 | 54.2% | 50.0% | 0.830 | 0.512 | 0.083 | +6.0 | +5.2 | $0.294 |
| soul-core | 3,038 | 49.2% | 42.0% | 0.886 | 0.550 | 0.084 | +0.9 | +10.2 | $0.320 |
| soul-full | 4,270 | 53.4% | 49.5% | 0.824 | 0.517 | 0.064 | +5.2 | +6.0 | $0.457 |
| mimic-json | 3,942 | 53.7% | 49.5% | 0.808 | 0.505 | 0.120 | +5.4 | +5.7 | $0.567 |

No prediction failed; all ten drafts were written. The reader's `state` accuracy (59.4%) is below Jev's on the same
kind of state (62.5% at k = 30 over 60 people), as E6 found for DeepSeek on this import.

### Jev reader, 60 people, 20 targets each (raw scale)

| View | Tokens | Accuracy | Top-1 | Log loss | Brier | ECE | Lift | Transfer loss | $/1k |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| context | 13 | 57.0% | 48.8% | 1.265 | 0.673 | 0.254 | — | +4.9 | $0.007 |
| state | 2,195 | 61.9% | 56.0% | 1.071 | 0.569 | 0.169 | +4.9 | — | $0.011 |
| card (12, surprise) | 956 | 62.8% | 55.6% | 1.099 | 0.569 | 0.165 | +5.8 | −1.0 | $0.009 |
| soul-core | 2,798 | 65.6% | 57.3% | 1.582 | 0.621 | 0.189 | +8.5 | −3.7 | $0.012 |
| soul-full | 4,017 | 66.2% | 59.2% | 1.187 | 0.555 | 0.148 | +9.2 | −4.3 | $0.015 |
| mimic-json | 3,942 | 62.7% | 55.8% | 1.207 | 0.582 | 0.177 | +5.7 | −0.8 | $0.017 |

1,200 targets; no prediction failed; 55 of 60 drafts were written and five timed out, so five people's soul views
carried no narrative. A negative transfer loss means the export beat the live state. For Jev the ordering is the
reverse of DeepSeek's: the narrative views win on accuracy (+3.7 points for the core profile, +4.3 for the full one)
and the core profile, which holds the narrative and no answers, loses badly on log loss (1.582 against 1.071: Jev
trusts a summary more than it should). The narrative is DeepSeek's reading of the same 30 answers, so the inference
was done by the LLM and Jev read its conclusion. This is the same shape as E6's exploratory lead on served questions
(`derived` gave Jev +4.8 points of accuracy and no log-loss gain), now on 60 people and 1,200 questions.

## With the calibrated primary (`@jev-predict.v2`, the served config's)

The same cells with the calibration temperature on, one pass, intervals over people. Log loss, Brier and ECE are on
the served scale. Surprise is ranked on the raw scale, as production ranks it.

| State | k | Accuracy | Log loss | ECE | Dispersion | Δ accuracy vs served [90% CI] | Δ log loss vs served [90% CI] | People better / worse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (context only) | – | 59.3% | 0.850 | 0.081 | — | — | — | — |
| full (served) | 10 | 59.4% | 0.832 | 0.036 | 0.176 | — | — | — |
| full (served) | 30 | 62.2% | 0.823 | 0.036 | 0.201 | — | — | — |
| full (served) | 100 | 66.5% | 0.851 | 0.111 | 0.124 | — | — | — |
| card 12 · mixed (recency) | 10 | 59.7% | 0.835 | 0.041 | 0.174 | +0.3 [−0.1, +0.8] | +0.003 [+0.001, +0.006] | 22 / 38 |
| card 12 · mixed (recency) | 30 | 63.0% | 0.847 | 0.066 | 0.127 | +0.7 [−0.5, +2.0] | +0.024 [+0.002, +0.047] | 26 / 34 |
| card 12 · mixed (recency) | 100 | 65.6% | 0.850 | 0.106 | 0.101 | −0.9 [−1.5, −0.2] | −0.001 [−0.007, +0.004] | 29 / 31 |
| card 12 · surprise | 10 | 59.5% | 0.831 | 0.037 | 0.172 | +0.1 [−0.3, +0.6] | −0.000 [−0.003, +0.002] | 34 / 26 |
| card 12 · surprise | 30 | 62.2% | 0.846 | 0.051 | 0.141 | −0.1 [−1.3, +1.2] | +0.023 [+0.002, +0.043] | 23 / 37 |
| card 12 · surprise | 100 | 65.8% | 0.842 | 0.107 | 0.128 | −0.7 [−1.4, +0.1] | −0.010 [−0.016, −0.004] | 33 / 27 |
| card 6 · surprise | 10 | 60.5% | 0.828 | 0.036 | 0.202 | +1.1 [+0.3, +1.9] | −0.004 [−0.010, +0.002] | 36 / 24 |
| card 6 · surprise | 30 | 63.1% | 0.844 | 0.056 | 0.127 | +0.9 [−0.6, +2.3] | +0.021 [−0.001, +0.044] | 28 / 32 |
| card 6 · surprise | 100 | 65.7% | 0.846 | 0.110 | 0.121 | −0.8 [−1.5, +0.0] | −0.005 [−0.013, +0.002] | 34 / 26 |

- The accuracy picture is unchanged: a 12-answer card is level at k = 30 and about a point behind at k = 100.
- After calibration, `surprise` is a small log-loss gain at k = 100 and a loss at k = 30; it is not a lever worth a
  policy of its own.
- Calibration drifts with the state: ECE 0.036 at k = 10 and 30, 0.111 at k = 100 for the served state.
- Every 12- or 6-answer card halves dispersion at k = 30 and k = 100.

## Where the lift comes from

The import's answer order and the held-out mix decide what "learning" could mean here. Wave 1–3 answers arrive in the
survey's order: nine demographics (region, sex, age, race, citizenship, party, income, ideology, household), then
sixty Big Five rows, then materialism and empathy scales, vocabulary, syllogisms, games, lotteries and the rest. The
held-out wave 4 items are 61% product choices ("Please consider the following product category…", pick a product in
a grocery store), 15% policy support ("Would you support or oppose…"), 12% probability tasks (decks, dice, marbles)
and 12% other. No held-out domain appears in the first 100 answers, so nothing below is copying: every point of lift
is transfer from demographics and personality scales to a decision in another domain.

Beyond the §9.9 budget the replayed state is the 18 most recent answers: with no target questions to retrieve for,
the similarity rank is empty and the builder falls back to recency, so at k = 100 the state holds answers 83–100
(materialism and empathy rows) and none of the demographics. Production builds its state for the candidate batch and
retrieves by lexical similarity to it, which this replay does not reproduce (nor does E6's Twin arm), and which would
not find "party" for "a carbon tax" either.

Lift of the served state by target domain, paired by question, intervals over people:

| Target domain | Items | k | State holds | Baseline | Served state | Lift [90% CI] |
| --- | --- | --- | --- | --- | --- | --- |
| product choice | 2,400 | 30 | demographics + 21 Big Five rows | 55.0% | 59.3% | +4.3 [+1.8, +6.9] |
| product choice | 2,400 | 100 | 18 materialism and empathy rows | 55.0% | 66.5% | +11.5 [+8.7, +14.5] |
| policy support | 600 | 30 | demographics + 21 Big Five rows | 68.5% | 72.8% | +4.4 [+0.6, +8.1] |
| policy support | 600 | 100 | 18 materialism and empathy rows | 68.5% | 69.6% | +1.2 [+0.5, +2.0] |
| probability task | 452 | 30 | demographics + 21 Big Five rows | 75.2% | 75.2% | +0.0 [+0.0, +0.0] |
| probability task | 452 | 100 | 18 materialism and empathy rows | 75.2% | 75.2% | +0.0 [+0.0, +0.0] |
| other | 480 | 30 | demographics + 21 Big Five rows | 53.1% | 54.0% | +0.8 [−2.7, +4.4] |
| other | 480 | 100 | 18 materialism and empathy rows | 53.1% | 53.8% | +0.6 [−2.3, +3.5] |

Three things follow.

- **What the state keeps decides which domains transfer.** Party and ideology (answers 6 and 8) carry the policy
  items: +4.4 while the state holds them, +1.2 once recency has dropped them. The materialism rows carry the product
  items: +11.5 at k = 100 against +4.3 when the state held demographics and Big Five rows instead. Product choices are
  61% of the held-out items, so the headline lift at k = 100 is 96% product choice. Recency is domain-blind, and the
  answers that matter most for a question are often the oldest ones.
- **Some items are state-insensitive.** On the probability tasks Jev's prediction is the same whatever the state:
  lift +0.0 with an empty interval on 452 items. The model has decided the person is irrelevant to a question about
  decks and dice. Those items measure nothing about learning and should be reported apart.
- **Lexical similarity does not find what transfers.** Sorting the held-out items by the nearest evidence prompt's
  word overlap puts the product items in the middle tercile and the policy and probability items at the ends, so the
  terciles order by domain, not by relatedness; "party" shares no words with "carbon tax", and "my belongings are
  mindfully selected" none with a soft-drink choice. That is why `similar` and E6's `relevant` cannot beat `recent`
  here, and why target-aware retrieval needs meaning, not words.

## E6 on the same import (ADR-0053)

The pre-registered rule gives `insufficient` because the import holds no served Mimic questions; the Twin rows stand
on their own. Each row compares the `full` view (the state as served) with `context`, Jev calibrated
(`decision:typesafe/jev-1.13@jev-predict.v2`), intervals by person.

| k | Δ log loss [90% CI] | Δ item accuracy, points [90% CI] | People better / worse | Learns |
| --- | --- | --- | --- | --- |
| 10 | −0.038 [−0.060, −0.017] | +2.7 [+0.4, +5.1] | 43 / 17 of 60 | yes |
| 30 | −0.049 [−0.074, −0.022] | +4.0 [+1.3, +6.7] | 43 / 17 of 60 | yes |
| 100 | −0.007 [−0.021, +0.007] | +6.6 [+3.5, +9.6] | 32 / 28 of 60 | accuracy only |

`relevant` against `full`: −1.4 [−2.4, −0.3] points at k = 10, +1.1 [−0.8, +3.0] at k = 30, −0.0 [−1.1, +1.2] at
k = 100, with log loss +0.008, −0.002 and +0.013. `derived` equals `context` on this import (no traits are estimated for
imported people), and `answers` equals `full`. DeepSeek ran on 10 people at k = 30 only: +3.1 [−4.4, +10.0] points,
too few to decide.

## Caveats

- These are imported survey takers, not Mimic users, and E6's prod readout already showed that Twin's held-out items
  (repeated batteries) reward earlier answers in a way Mimic's next question does not. Numbers here rank states and
  policies for the same predictor on the same questions; they do not say what a Mimic session will gain.
- Jev ran on its raw scale, so every log loss, Brier and ECE above is uncalibrated. Accuracy and top-1 are unaffected
  by a temperature; calibration-sensitive conclusions (`surprise`, the small cards' log loss) need the calibrated
  primary before they carry over.
- Transfer ran on 10 people for DeepSeek, and the soul drafts were written by the same model family that read them.
- The calibrated `surprise` cells ranked training answers by the baseline's surprise on the calibrated scale. The
  review of this work moved the annotation onto the raw scale, as stored signals are (ADR-0056), which can reorder
  answers across questions with different numbers of options. The raw-Jev cells are unaffected. A re-run with the
  fixed annotation was started and stopped: the OpenRouter account ran out of credit (HTTP 402 on every call), so
  those two rows still carry the earlier ranking.
- Beyond the budget the replayed state is recency-only (no target questions to retrieve for), where production
  retrieves by lexical similarity to the candidate batch. At k = 100 "served state" here means the 18 most recent
  answers; at k ≤ 30 nothing is dropped and the comparison is exact.
- `ensemble` and `population` could not run on this import: it stores no shadow predictions and estimates no traits.
  Both wait for the consented cohort.

## Next

What this changes in the agenda is written up in `docs/RESEARCH.md` §10 and in E7's design (`docs/PROBE.md`).

1. A probe set with items at known transfer distances (E7), so that "learns from answers" is measured per distance
   on served people, with shared items for item means and dispersion.
2. Retrieval and compaction by meaning: an embedding or LLM-chosen "what matters for this question" step in place of
   lexical similarity, and derived traits that keep party, income and materialism after the answers have left the
   window. Test as `relevant`-style views on E7's probes.
3. The LLM-written state for Jev: a reflector draft as the primary's state, calibrated on its own, shadowed on
   served questions.
4. Calibration as a function of state size, since one temperature holds at 30 answers and not at 100.
5. The `surprise` card as the export for agents: level on accuracy at 30 answers, best dispersion of the compressed
   states, half the tokens. Lead SOUL.md with the evidence block for LLM readers and with the narrative for Jev.
