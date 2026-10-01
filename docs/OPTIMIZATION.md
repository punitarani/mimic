# Mimic — Evals and GEPA-style prompt and harness optimization

v1 · 2026-09-30 · Status: M9 (evaluator) and M10 (optimizer, shipping path) are built, and M11's fits are
reported; see ADR-0028 and "What is built" below. M12 (re-derivation) and M13 (generator) are not built yet.

## What is built

| Piece | Where | Notes |
| --- | --- | --- |
| Prompt components and registered variants | `packages/core/src/components.ts`, `docs/prompts/variants/` | `predict.system`, `predict.user`, `state.evidence.line`, `jev.instructions`, `jev.choice`, `jev.noul.true`, `jev.noul.false`; harness: reasoning effort or budget, max tokens, `probs`/`reasoned` schema, Jev state as JSON or text, calibration temperature; per-model harness overrides (ADR-0041) |
| Variant predictor IDs | `parsePredictorId`, `makePredictor`, `pnpm backfill` | `llm:<model>@<version>`, `decision:<model>@<version>` (`jev:` before ADR-0054, still read); unsuffixed IDs unchanged |
| `mimic-eval evaluate` | `packages/eval/src/optimize/` | `--from stored` (free: per predictor, split, person and type; paired comparisons of each model's versions on shared questions; self-consistency; temperature, shrinkage and pooling fits) or live candidates with paired deltas and `--repeat` for the noise floor |
| `mimic-eval diagnose` | same | One reflection-model call per person (up to `--people`) over a stored predictor's costliest misses; local only |
| `mimic-eval optimize` | same | GEPA loop: Pareto sampling, minibatch reflection, noise-margin acceptance, leakage lint, spend and call caps, resume, holdout check, verdict ("Improved" only when the gain replicates on the holdout, ADR-0048), `PREDICT_PROMPTS` snippet |
| Actions → Optimize | `.github/workflows/optimize.yml` | Export prod (scrubbed), optional Twin-2K-500, free report, optional capped run; publishes to `/lab` |

Decisions taken for v1 are in §14 and ADR-0028. Deviations from the proposal below: cache hits are not logged as
zero-cost `model_calls` rows (they are not calls; the run's own cache is in `--run-dir`); the components not yet
exposed (`state.section.*`, `state.trait.line`, `jev.state.keys`, `jev.trait.instructions`, `reflect.system`,
`hyp.system`, `gen.system`) wait for M12/M13; prompt versions travel in predictor IDs rather than a new config field,
so no config schema change was needed.

### How to run it

```
# Free: a report from the predictions already stored online (every predictor, calibration fits)
pnpm eval -- export --env prod --out data/prod.sqlite          # or Actions → Optimize, mode "report"
pnpm eval -- evaluate --from stored --data data/prod.sqlite

# Capped optimization of Jev's templates, seeded from the calibrated variant (dominated by ~$0.03 reflection calls)
pnpm eval -- optimize --data data/prod.sqlite --predictor decision:typesafe/jev-1.13@jev-predict.v2 --max-usd 2

# Compare registered variants or candidate files on the same instances
pnpm eval -- evaluate --data data/prod.sqlite --predictor llm:deepseek/deepseek-v4.1-flash --candidate best.json
```

A winner: paste the printed `PREDICT_PROMPTS` entry into `packages/core/src/components.ts`, run
`pnpm --filter @mimic/core gen:docs`, merge, then `pnpm backfill --predictor decision:typesafe/jev-1.13@jev-predict.v3`.
An LLM winner's reasoning settings are written under `modelHarness` for the model it was optimized on, and the seed
variant's shared harness and other `modelHarness` entries are carried over, so other models keep theirs.

### Registered variants

| Version | What changes | Why |
| --- | --- | --- |
| `predict.v1`, `jev-predict.v1` | Nothing: the incumbent prompts and harness | The default for unsuffixed IDs |
| `predict.v1-direct` | Reasoning off (`effort: none`) | ADR-0038: Qwen Flash reasoned 1–4.5K tokens at effort low; kept in v6 as the reasoning-off control |
| `predict.v2` | Reasoning and caps per model: a low effort for GPT-6 Luna, DeepSeek and GLM; a 1,024-token budget for MiMo Flash and Qwen Flash, which take no effort level; caps at about twice the largest measured completion. The answer's keys are an enum of the options, with labels re-keyed as a fallback. Runs only on the five models it lists | ADR-0041: Qwen truncated on long states under the old 3,000 cap; medium effort bought nothing measurable; Qwen and GLM sometimes keyed a scale by its labels |
| `jev-predict.v2` | Jev's distribution softened by a calibration temperature of 4 (same top pick; accuracy on score questions can move) | ADR-0041: fitted on the prod dev person, held-out log loss 1.804 → 1.124 and ECE 0.267 → 0.098 |

`cfg.default.v6` runs every LLM shadow on `predict.v2`, plus `predict.v1-direct` for Qwen (reasoning off, ADR-0038) as
a control. `cfg.default.v7` makes `jev-predict.v2` the primary and retires the control (ADR-0048). For primaries still
on `jev-predict.v1`, `evaluate --from stored` derives calibrated Jev from the stored answers as rows with the role
`derived`, for free. `jev-predict.v2` also seeds Actions → Optimize.

> Scope: how to turn the two real sessions we have (50–90 questions each) plus Twin-2K-500 into an honest eval loop,
> and how to run DSPy/GEPA-style reflective optimization over the prompts and the harness without breaking the
> research invariants in `docs/PLAN.md` §3. Sections 11–14 are the build plan; everything before that is the
> reasoning behind it.

---

## 0. Summary

**What GEPA is, in one paragraph.** GEPA (Genetic-Pareto; Agrawal et al. 2025) treats a system as a set of named text
components (prompts, templates, instructions). It keeps a pool of candidates, tracks each candidate's score on every
validation instance, samples a parent from the per-instance Pareto frontier, runs it on a small minibatch while capturing
traces, asks a strong "reflection" model to read the traces and the textual feedback and write an improved component,
accepts the child if it beats the parent on that minibatch, then scores it on the full validation set. It typically needs
a few hundred metric calls, not thousands. The library is model-agnostic: an adapter supplies `evaluate(batch, candidate)`
returning per-instance scores plus traces, and `make_reflective_dataset(...)` turning traces into `{Inputs, Generated
Outputs, Feedback}` records for the reflection model.

**What Mimic already has that makes this cheap.** Every served question has a sealed state (R2 blob, hash in D1), a
primary Jev prediction, a context-only baseline and 3–4 LLM shadow predictions, all scored the moment the answer landed.
`mimic-eval export` produces a scrubbed SQLite file; `replay` rebuilds sealed states exactly (ADR-0017); `report` publishes
to `/lab`; the Twin-2K-500 importer gives 2,000 more people in the same typed format. Nothing else in the repo needs to
change for the *eval* half. The *optimization* half needs a candidate evaluator, an optimizer loop and a shipping path.

**The honest constraint.** Two people are not enough to *learn* a prompt on; they are enough to *check* one. Everything in
this plan trains on Twin-2K-500 dev people (and, for person-agnostic components, on one real user at a time) and treats
the real sessions as validation. The literature says to expect modest gains from prompt and persona-format changes (a few
accuracy points on Twin-2K-500), larger gains in log loss from calibration, and no gain at all from anything that ends up
encoding one person into a shared prompt. The plan is built to detect that last failure mode.

**Build order (details in §11):**

| Milestone | Deliverable | Why first |
| --- | --- | --- |
| M9 Evaluator | `mimic-eval evaluate` (candidate → per-question scores + feedback), `diagnose` (reflective failure analysis), baseline report on the real sessions from stored scores | Needed by humans and by the optimizer alike; zero new model calls for the first report |
| M10 Optimizer | `mimic-eval optimize` (GEPA loop in TypeScript over the real engine code), leakage lint, first runs on the Jev input templates and the LLM predictor prompt, shipping path via new prompt IDs, config fields and `pnpm backfill` | Highest expected fidelity gain per dollar; Jev calls are nearly free |
| M11 Calibration and ensembles | Fitted temperature scaling and Jev+LLM pooling as versioned post-processors | Cheapest, most reliable log-loss win; not a prompt change |
| M12 Re-derivation | `replay --rederive`: recompute traits and insights with a candidate config at each checkpoint | Unlocks optimizing the reflector, trait wording and state strategy end to end (RQ3, E2, E4) |
| M13 Generator | Composite question-quality metric; optimize `gen.v1` | Different metric, more Goodhart risk; last |

---

## 1. What we have, and the gaps

### 1.1 Data

- **Two real sessions**, 50–90 questions each, in prod D1. Per person that is 10 anchors, roughly 6–10 repeat probes
  and 35–70 adaptive questions; call it **≈ 100–150 scored (state, question, answer) triples** in total, each with a
  primary Jev prediction, a baseline and 3–4 shadow predictions already scored. Some answers carry an optional
  free-text "why" (count them in the first report); each one is gold-standard textual feedback for a reflective
  optimizer.
- **Prerequisites to check before anything else** (both are hard gates, not preferences):
  1. `mimics.consent_research` must be true for both, or the export drops them (invariant 7). Nothing in this plan may
     run on non-consented data.
  2. `mimics.split` is `hash(mimicId)`, so each person is independently `dev` or `test` (80/20). A `test` person may be
     used for the final report only (PLAN §12.4). With two people the plan below already treats both as validation,
     but a `test` person must never be in an optimizer's minibatch or Pareto set.
- **Twin-2K-500** (Toubia et al. 2025, CC BY 4.0): 2,058 U.S. respondents; the importer maps single-choice and matrix
  items onto `choice`/`noul`/`score`, waves 1–3 become evidence, wave 4 the held-out set, and wave 1–3 answers to wave
  4 items become repeat pairs. Hugging Face is unreachable from this environment; the user converts the parquet once
  (`packages/eval/src/twin.ts` has the one-liner) and runs `mimic-eval import twin2k500`.
- **Gate calibration set**: 32 hand-labeled candidate questions at `packages/eval/data/gates.labeled.v1.json`
  (ADR-0015). **Finding:** that path is under the gitignored `data/` pattern and the file was never committed, so it
  exists only on the machine that ran the calibration, if at all. Recover it (or relabel) and move it to
  `packages/eval/fixtures/`, which is tracked, before M13 depends on it.

### 1.2 Machinery already in place

| Need | Have |
| --- | --- |
| Reproduce the exact online condition offline | Sealed states pinned to `questions.state_at`; `loadMimicDataAt`; `replay --mode online` passed at 100 % state-hash match on local data |
| Score a distribution | `scorePrediction` (top-1, item accuracy, log loss, Brier), `expectedCalibrationError`, `predictorMetrics` (lift paired by question, $/1k, latency), `itemAcrossPeople` (correlation, dispersion ratio) |
| Run predictors offline with logging and budgets | `openLocalEngine` + `Gateway` (every call is a `model_calls` row and a trace, invariant 5) |
| Offline tests with no spend | `FakeDecisions`, `FakeLlm`, seeded IDs |
| Publish results | `writeReport`, `publishReport`, `/lab/evals/[id]` |
| Add a predictor variant to served questions retroactively | `pnpm backfill --predictor` (ADR-0024) |

### 1.3 Gaps this plan fills

1. **No candidate abstraction.** Prompts are constants in `packages/core/src/prompts.ts`; the LLM predictor's
   reasoning effort, `maxTokens`, output schema and the state renderer (`renderStateText`) are hardcoded; the Jev
   instruction and criteria templates are string literals in `jev.ts`. The prediction `promptVersion` is the literal
   `'predict.v1'` in two places (`engine/session.ts`, `engine/jobs.ts`), and `PipelineConfig.predictor` has no prompt
   version at all, so two LLM shadows with different prompts cannot currently coexist.
2. **No per-question evaluation record with textual feedback.** `replay` aggregates straight to metrics.
3. **No re-derivation.** `replay` loads *persisted* traits and insights, so a candidate reflector prompt cannot be
   evaluated end to end.
4. **No optimizer, no leakage checks, no evaluation cache.**
5. **No noise-floor measurement.** Jev is not bit-for-bit deterministic (VALIDATION M5) and the LLMs run at low
   effort without a temperature knob; acceptance decisions need a measured noise margin.

---

## 2. GEPA mapped onto Mimic

| GEPA concept | Mimic instance |
| --- | --- |
| Candidate | `{ components: Record<componentId, text>, harness: HarnessOverrides }`, hashed like a config |
| Text component | See §4.1: predictor system prompt and user template, state renderer templates, Jev instruction and criteria templates, Jev state key names, trait-read instruction, reflector prompt, hypotheses prompt, generator prompt |
| Task instance | One sealed (state, question, answer) triple: a real served question, or a Twin held-out item at a checkpoint |
| Task LM | Whatever the candidate targets: Jev for the primary path, one of the four LLMs for shadows |
| Metric | Per-instance log loss (primary), with item accuracy, Brier, top-1, cost and state tokens recorded as extra objectives |
| Textual feedback | Built from the answer, the "why", the baseline's prediction, the earlier answers that pointed the right way, and the repeat agreement for that item (§5.3) |
| Trajectory | The rendered state, the question and options, the raw model output, the distribution |
| Reflection LM | A frontier model on OpenRouter, used *only* offline in the eval CLI, never in a production config |
| Pareto frontier | Per-instance best scores across candidates; parents sampled from candidates that are best on at least one instance |
| Validation set | Twin dev people at checkpoints k ∈ {10, 20, 30}; the real dev person(s) as an in-domain check, never for selection |
| Budget | `maxMetricCalls`; a full pass over the real sessions costs cents (§12) |

Why GEPA rather than MIPRO/BootstrapFewShot-style demo selection: few-shot demos drawn from other people's sessions
are cross-person data in a prompt, which invariant 8 forbids outside a flagged experiment. Instruction-only
optimization stays inside the invariant. Synthetic, hand-written demos remain allowed and can be a component.

Why not RL or fine-tuning: PLAN §1 non-goals, and two people.

---

## 3. Evaluation protocol

### 3.1 The unit of evaluation is a sealed prequential prediction

For question *t* of person *p*, the state is built from answers with seq < *t* and derived data as of the question's
`state_at`, exactly as online. A candidate changes *how the state is rendered and asked*, never *what it contains*.
`buildState` stays the sealing boundary; the evaluator passes its output through the candidate's renderers. This keeps
invariant 1 by construction and makes every evaluation record carry `stateHash`, `evidenceSeqMax`, `modelSnapshot` and
the candidate hash (invariant 4).

Three evaluation modes:

| Mode | States | Use |
| --- | --- | --- |
| `online` | Every served anchor/adaptive question of each person, state as served | The in-domain number. n ≈ 100–150 on the real sessions |
| `checkpoint` | First k evidence items → predict every later item (existing `replay` semantics) | Learning curves; mirrors the 30-question session on Twin people whose evidence is far longer |
| `heldout` | Twin wave 1–3 (first k) → wave 4 items | The large, cross-person dev set |

Twin items are survey-style rather than Mimic's scenario questions, so gains on Twin are necessary but not sufficient; the
real sessions decide.

### 3.2 Splits and leakage rules

1. **Dev/test by `hash(mimicId)` never changes.** Test people (real or Twin) appear only in the final report of a
   milestone.
2. **Optimizer sees Twin dev only** (a fixed, seeded subsample: start with 60 people for minibatches and 150 for
   validation; grow if the frontier keeps moving). Real dev people are used for a *leave-one-person-out* check only:
   a candidate must not lose on the person it never saw.
3. **Winner's curse.** The best of N candidates on the validation set is optimistically biased. The reported number for
   a shipped candidate is its score on Twin test plus the real sessions, computed once, after selection.
4. **Temporal sanity within a person.** Because the state for question *t* already contains answers 1..t−1, using early
   questions to reflect and later ones to validate is legitimate and mirrors deployment; it is a secondary check, not
   the main protocol.
5. **The online check is the real test.** A shipped candidate runs as a shadow on new questions (§9); that comparison is
   within-person, on identical sealed states, and fully out of sample.

### 3.3 Metrics and objectives

- **Primary objective: mean log loss** (proper scoring rule, most sensitive at n ≈ 150, and what a calibration layer
  improves). GEPA scores are `−logLoss` per instance so higher is better.
- **Reported alongside, always:** item accuracy (the headline's ingredient), top-1, Brier, ECE (10 bins), lift over the
  context-only baseline paired by question, per-type breakdown (`choice` / `noul` / `score`; score accuracy is
  1 − MAD/4 and behaves differently), cost per prediction, p50/p95 latency, state tokens, failure rate.
- **Guards, evaluated on Twin (they need many people):** across-person correlation per item and the dispersion ratio
  (SD of predictions across people ÷ SD of answers). The mega-study of digital twins (Peng, Toubia et al. 2025) found
  twin–human correlations around 0.2, twin answers less variable than humans', and individual accuracy no better than
  demographics-only personas. A candidate that raises accuracy by predicting the population mode will show as a falling
  dispersion ratio and a shrinking baseline lift; reject it.
- **Constraints, not objectives:** primary-path state tokens ≤ budget (Jev's context is 32K and its accuracy is reported
  to fall as the state fills with material the question does not need), cost per prediction ≤ 2× the incumbent,
  p95 Jev latency on the sync path.

### 3.4 What n ≈ 150 can and cannot tell us

- Accuracy has a standard error of about 4 points at n = 150, so an unpaired 5-point difference is inside the noise.
  Paired per-question differences against the incumbent (same questions, same states) are much tighter; report the
  bootstrap CI of the paired delta in log loss and accuracy, per person and pooled.
- Two people are two clusters. Do not pool them into one CI and call it generalization; require the sign to agree on both
  and report both. Generalization claims rest on Twin.
- Repeat probes give self-consistency per person (6–10 pairs each, smoothed toward the 0.8 prior). Show it next to
  every accuracy; it bounds what any predictor can reach.
- **Measure the noise floor first:** evaluate the incumbent twice on the same instances and record the paired
  variation. The optimizer's acceptance margin (§6.2) must exceed it.

### 3.5 First report needs no model calls

Everything for a first per-predictor report already sits in `predictions` and `scores`. `mimic-eval evaluate --from
stored` should produce the §3.3 table for the five predictors on the real sessions, per person and per type, with the
fidelity line, self-consistency and per-question log-loss deltas between predictors. That is the current-state baseline
every later run is compared to, and it answers most of RQ1 for these two people today.

---

## 4. The candidate space

### 4.1 Text components (what a reflection model may rewrite)

| Component ID | Lives in today | Affects | Placeholders that must survive |
| --- | --- | --- | --- |
| `predict.system` | `PROMPTS['predict.v1'].system` | LLM shadows (and the LLM fallback primary) | none |
| `predict.user` | Inline in `LlmPredictor.one` | LLM shadows | `{state}`, `{prompt}`, `{options}` |
| `state.section.*` (identity, traits, insights, evidence headers) | `renderStateText` | LLM shadows, reflector, hypotheses, rationale | none |
| `state.evidence.line` | `renderStateText` | Same | `{seq}`, `{q}`, `{options}`, `{answer}`, `{why}` |
| `state.trait.line` | `renderStateText` | Same | `{facet}`, `{mean}`, `{confidence}` (a candidate may map `{mean}` to words such as "leans cautious" via a fixed helper) |
| `jev.predict.instructions` | `predictionQuestion` | Primary and baseline | `{prompt}` |
| `jev.choice.criterion`, `jev.noul.true`, `jev.noul.false` | `predictionQuestion` | Primary and baseline | `{label}` for choice |
| `jev.state.keys` (JSON key names: identity, traits, insights, evidence, q, answer, options, why) | `stateForProvider` | Primary and baseline | fixed key set, renamable |
| `jev.state.format` (`json` or the text renderer) | new | Primary and baseline | harness flag, paired with the `state.*` components |
| `jev.trait.instructions` | `traitQuestion` | Trait reads → `structured`/`full` states → primary | `{name}`, `{low}`, `{high}` |
| `reflect.system` | `PROMPTS['reflect.v1']` | Insights → `summary`/`full` states → primary (needs M12) | none |
| `hyp.system` | `PROMPTS['hyp.v1']` | BALD selection only | `{k}` |
| `gen.system` (+ style rules) | `PROMPTS['gen.v1']` | Question quality (M13) | none |

Not text components: the ontology's 33 facets × 5 pole labels (too many strings to evolve blindly; treat label wording
as a hand-run experiment), the quality-gate wording (it has its own calibration loop, ADR-0015), and the anchors.

### 4.2 Harness knobs (searched by the same evaluator, not rewritten by the reflection model)

| Knob | Today | Candidates worth testing |
| --- | --- | --- |
| LLM output schema | `{ probs: [{key, p}] }` | `{ reasoning, probs }` (a short rationale before probabilities); `{ answer, confidence }` converted to a distribution |
| Reasoning effort | `low` | `none`, `medium`; cost and latency are objectives |
| Probability source | Verbalized JSON | `logprobs`/`top_logprobs` over a single answer token where the provider supports it (OpenRouter exposes both); the literature finds verbalized probabilities often better calibrated for RLHF models, so measure rather than assume |
| Samples per prediction | 1 | 3–5 with averaging (self-consistency); option-order permutation to cancel position bias |
| Batching | One LLM call per question | All pool candidates in one call sharing the state prefix, as Jev does; cheaper and more internally consistent |
| State strategy | `full` | `raw`, `structured`, `summary` (E2) |
| Evidence selection under budget | anchors + top-`retrievalK` by similarity + last `recentN` | Retrieval even when under budget; similarity-sorted vs chronological; drop `options` for answered items; include or drop "why" |
| Section budgets | identity 600, traits 500, insights 800 | Fewer traits (confidence-filtered), no insights, for Jev especially |
| Jev score items | `score` question with the 5 labels | `choice` over the same 5 labels; compare calibration of the expected index |
| Post-processing | none | Temperature scaling per predictor and type; shrinkage toward the baseline (p = (1−α)·p + α·p_base); Jev+LLM log-linear pool (M11) |
| Selector | entropy λ = 0.3, μ = 0.5; BALD k = 4 | Tuned by `select` simulation (biased) and arms; not by this loop |

### 4.3 Explicitly out of bounds

- Cross-person few-shot demos (invariant 8). Synthetic demos are fine; verbatim copies of a real person's question,
  answer or "why" into a prompt are leakage and the lint in §6.4 rejects them.
- Anything that lets the state for question *t* see answer *t* (invariant 1). Candidates only touch rendering.
- Tuning on `test`-split people (PLAN §12.4).
- Metrics from LLM-simulated users (PLAN M2). Simulated users may smoke-test the loop offline, nothing more.

---

## 5. The evaluator: `mimic-eval evaluate`

```
mimic-eval evaluate --data <export.sqlite> --candidate <cand.json> [--mode online|checkpoint|heldout]
                    [--checkpoints 10,20,30] [--split dev|test|all] [--limit N] [--ids <file>]
                    [--from stored] [--repeat 2] [--out data/evals/<run>/]
```

### 5.1 Candidate file

```json
{
  "label": "predict.v2-draft-3",
  "parent": "sha256…",
  "components": {
    "predict.system": "…",
    "predict.user": "STATE:\n{state}\n\nQUESTION: {prompt}\nOPTIONS:\n{options}",
    "state.evidence.line": "#{seq} {q} [{options}] → {answer}{why}"
  },
  "harness": {
    "predictor": "llm:deepseek/deepseek-v4.1-flash",
    "reasoningEffort": "low",
    "maxTokens": 3000,
    "schema": "probs",
    "stateStrategy": "full",
    "budgetTokens": 8000,
    "retrievalK": 12,
    "recentN": 6,
    "postprocess": null
  }
}
```

Unspecified components default to the incumbent (`predict.v1`, `jev-predict.v1`, the current renderer), so the incumbent
is the empty candidate. The candidate hash is `sha256(canonicalJson(candidate))`; a candidate is immutable once
evaluated, like a config.

Implementation note for `packages/core`: the incumbent strings move from literals into a `PromptComponents` object with
the IDs above, resolved through one `renderers(candidate)` function that `LlmPredictor`, `predictionQuestion`,
`renderStateText` and `traitQuestion` take as a parameter (defaulting to the incumbent). Placeholders are validated
against the table in §4.1 before a candidate is accepted. This is a refactor with no behaviour change, pinned by the
existing config-hash and docs-sync tests plus a snapshot test that the incumbent candidate renders byte-identical
prompts.

### 5.2 Evaluation record (one JSONL line per instance)

```
{ candidateHash, instanceId: "<mimicId>:<questionId>[@k]", mimicId, questionId, k?, type, kind,
  stateHash, evidenceSeqMax, stateTokens, promptVersion, predictorId, modelSnapshot,
  dist, argmax, answer, why?, score: { logLoss, itemAcc, top1, brier }, baseline: { dist, logLoss, itemAcc },
  costUsd, latencyMs, ok, error?, feedback: "…", trace: { renderedState (truncated), userMessage, rawOutput } }
```

Plus `summary.json` (the §3.3 table per person, per type, pooled; paired deltas against `--baseline <run>`), and
`report.md` for `/lab`. Every model call still goes through the `Gateway` with purpose `eval.evaluate`, so cost is
accounted the same way as production (invariant 5).

### 5.3 Feedback text (what makes reflection work)

Per instance, in this order, truncated to a few hundred tokens:

1. Outcome: "Missed: predicted *a* (0.62), the person chose *b*; log loss 0.97" or "Hit but overconfident: 0.96 on a
   score item the person answered one step away."
2. The person's own reason when present (`answers.why`), verbatim. This is the single most valuable line.
3. The context-only baseline's view: "Baseline (profile only) gave *b* 0.55: the evidence pushed the wrong way." or
   "Baseline also missed: this is not in the profile."
4. Up to three earlier answers in the state most similar to the question (by embedding or lexical similarity) that
   pointed toward the true answer, quoted as `#seq question → answer`.
5. Reliability: the repeat agreement for this item if it was probed ("the person answered a repeat of this item the same
   way", or "…differently, so treat this miss as noise"), and the facet's trait confidence.
6. For `score` items: the expected index vs the answer, and whether the distribution was too flat or too peaked.

The record's `Inputs` shows the rendered state truncated to the identity block plus the lines cited in (4), so the
reflection model reasons about the mechanism rather than skimming 3K tokens of evidence.

### 5.4 Cache and noise floor

- An `eval_cache` table keyed by `sha256(provider, model, request body)` stores the raw response, so re-scoring an
  unchanged (candidate, instance) pair is free and a full-validation pass of a previously seen candidate costs nothing.
  Cache hits still write a `model_calls` row with `cost_usd = 0` and a `cached` flag, so the ledger stays complete.
- `--repeat 2` bypasses the cache for the incumbent and reports the paired variation between passes: the noise floor.

### 5.5 `mimic-eval diagnose`: reflective evals without optimizing anything

The same reflective dataset, sent to the reflection model once per person (invariant 8: no prompt mixes people) with a "cluster and explain" prompt instead of a
"rewrite" prompt, gives a failure analysis per predictor: which question types and facets it misses, whether it
ignores the "why", whether score items collapse to the middle, whether it over-weights identity facts. Output is
markdown under `data/evals/<run>/diagnose.md`, publishable with `report --to`. This is the deliverable for "run evals
GEPA-style" and it is useful on day one with the stored predictions alone. Without `--predictor` it reads every
predictor that filled `--role` (for `primary`, each config version's primary, never an LLM fallback; ADR-0048);
`--role shadow` needs `--predictor`.

---

## 6. The optimizer: `mimic-eval optimize`

```
mimic-eval optimize --data <twin.sqlite> --check <real-export.sqlite> --seed-candidate <cand.json>
                    --components predict.system,predict.user --predictor llm:deepseek/deepseek-v4.1-flash
                    --reflection-model <openrouter id> --train-people 60 --val-people 150 --checkpoints 20
                    --minibatch 6 --max-metric-calls 400 --run-dir data/optimize/<name> [--resume]
```

### 6.1 Loop

```
pool ← [seed]; scores[seed] ← evaluate(seed, val)               // per-instance
repeat until budget:
  parent   ← sample from Pareto set(pool, scores)                 // candidates best on ≥ 1 val instance,
                                                                  // weighted by how many instances they win
  batch    ← minibatch(train, size m, stratified by type)
  traces   ← evaluate(parent, batch, captureTraces)
  records  ← reflectiveDataset(traces, components)                // §5.3
  child    ← reflect(parent, records, component)                  // one component per step, round-robin or
                                                                  // chosen by the reflection model
  if lint(child) fails: continue                                  // §6.4
  if score(child, batch) − score(parent, batch) ≤ margin: continue
  scores[child] ← evaluate(child, val); pool ← pool ∪ {child}
  optional every K steps: merge two frontier candidates that win on disjoint instances
checkpoint pool, scores and history to run-dir after every accepted child
```

Selection of the final candidate: best mean val log loss among frontier members that satisfy the §3.3 constraints and do
not reduce the Twin dispersion ratio by more than 0.05; then one evaluation each on the real dev person(s) (LOPO) and,
for the milestone report only, on Twin test and the real test person if any.

### 6.2 Acceptance margin

`margin` = the measured noise floor on a minibatch of the same size (§5.4), plus a small constant. Without it, Jev's
call-to-call variation and the LLMs' sampling accept random children and the frontier fills with noise.

### 6.3 Reflection prompt (sketch)

```
You are improving one text component of a system that predicts how a specific person will answer a typed question,
given that person's earlier answers. Below are cases from the current version: the inputs the model saw, what it
predicted, the true answer, the person's stated reason if any, and feedback.

Write an improved version of the component "{componentId}".
Rules:
- It must work for any person. Never mention a specific person, place, employer, question, option or answer from
  the cases. Describe general strategy (how to weigh evidence, how to spread probability), not facts.
- Keep every placeholder {…} exactly as it appears. Do not change the output format contract.
- At most {maxWords} words. Return only the new text.

Current component:
…
Cases:
…
```

The reflection model is a frontier model on OpenRouter, chosen per run, logged through the gateway under purpose
`eval.reflect`, and never referenced by a production config. Its cost is the dominant cost of a run (§12).

### 6.4 Leakage lint (rejects a child before any evaluation)

1. Any 6-gram shared with a question prompt, option label, answer or "why" from the training instances.
2. Any identity token from the training people (name, employer, location, fact objects). On a scrubbed export these are
   `Participant` and empty strings; the lint matters when a `--keep-identity` export is used (§10).
3. Missing or extra placeholders; component over the word cap; a JSON key set for `jev.state.keys` that does not map
   one-to-one onto the fixed set.
4. Per-person overfit check at selection time: a candidate whose gain on Twin val comes from fewer than 20 % of people
   is flagged.

### 6.5 Why a TypeScript loop in `packages/eval`, and the alternatives

The loop above is a few hundred lines. Writing it in `packages/eval` means the optimizer runs the *actual* engine code
(`buildState`, `LlmPredictor`, `predictionQuestion`, `renderStateText`), so there is no drift between what was optimized
and what ships, tests use the existing fakes, and CI stays TypeScript-only. Options considered:

| Option | Verdict |
| --- | --- |
| Python `gepa` with a `GEPAAdapter` that shells out to `mimic-eval evaluate --ids … --candidate …` and reads the JSONL | Viable and the fastest way to try the mature library; a ~100-line adapter. Keep the evaluator's JSON contract stable so this stays possible. Costs a second toolchain in the repo. |
| `gepa-ts` (npm, MIT) | Claims 1:1 parity with the Python package but the repository was archived in April 2026 with 10 stars; vendor pieces if useful, do not depend on it. |
| `@ax-llm/ax` `AxGEPA` / `optimize()` | Optimizes components of Ax programs (`ax('…')` signatures) with its own model clients; Mimic's program is not an Ax program and re-expressing it would optimize a copy. Not a fit. |
| DSPy proper | Same adapter path as Python `gepa`; only worth it if demo-based optimizers are wanted, and those are limited by invariant 8. |

Decision proposed: build the evaluator with a stable JSON contract (M9), then the TypeScript loop (M10). If the loop
turns out to need the Python library's extras (merge heuristics, component selectors), the adapter route is a day's
work on top of M9.

---

## 7. Ranked harness experiments

Ordered by expected gain per dollar and by how much they touch the sync path. "Eval" says which evaluator mode decides.

| # | Experiment | Expected effect | Cost to test | Eval |
| --- | --- | --- | --- | --- |
| 1 | Baseline report from stored scores, per predictor, person and type; noise floor | Establishes where we are; free | $0 | `evaluate --from stored`, `--repeat 2` |
| 2 | Temperature scaling per predictor (fit on Twin dev, check LOPO on real) | Largest, most reliable log-loss and ECE gain; no accuracy change | cents | `evaluate` + fit |
| 3 | Jev state pruning: drop insights, confidence-filter traits, cap evidence to top-k similar even under budget | Jev is reported to lose accuracy on irrelevant material; also cuts latency and cost on the sync path | cents (Jev) | `online` on real, `heldout` on Twin |
| 4 | Jev instruction and criteria wording; state keys and evidence line format; text vs JSON state | Direct fidelity lever on the primary; GEPA target #1 | cents per pass | GEPA (M10) |
| 5 | LLM predictor prompt (`predict.system`, `predict.user`) with the `{reasoning, probs}` schema | Shadow lift; GEPA target #2; tells RQ1 whether the LLM gap is prompt or model | ≈ $0.05 per pass on real, ≈ $3 per Twin pass | GEPA (M10) |
| 6 | Jev + best-LLM log-linear pool; shrinkage toward baseline | Ensembles usually beat members on log loss; one config field | cents | M11 |
| 7 | Verbalized vs logprob probabilities; 3-sample averaging; option-order permutation | Calibration and position bias; provider-dependent | ≈ 3× shadow cost | `evaluate` harness flags |
| 8 | Trait values as words instead of numbers in states | Small; cheap | cents | `evaluate` |
| 9 | State strategy ablation `raw`/`structured`/`summary`/`full` with rederived state (E2) and reflector prompt optimization (E4) | Answers RQ3; requires M12 | dollars | `replay --rederive` |
| 10 | Generator prompt against a composite quality metric | Better questions → more information per session; Goodhart risk on the gates | dollars | M13 |
| 11 | Selector parameters λ, μ, k | Online arms only, pool simulation is biased | people | arms |

Item 3 deserves emphasis: the headline fidelity is Jev's, the sync path's p50 target is 800 ms, and Jev bills input
tokens only, so a smaller, better-shaped state may improve accuracy, latency and cost at once.

---

## 8. What "DSPy-style" adds beyond GEPA here

- **Declarative components.** Once the strings live in `PromptComponents` with placeholders, each pipeline stage
  (state renderer → predictor; evidence → reflector; scenario → question) is a "module" with an instruction and a typed
  I/O contract, which is the DSPy signature idea without the framework.
- **Assertions as feedback.** The citation guard, schema validation and option-coverage checks already exist; the
  evaluator turns their failures into feedback lines so the reflection model fixes format problems, not just accuracy.
- **Inference-time search.** With `valset = trainset` and per-instance tracking, the same loop produces a best-per-instance
  table; for the reflector that means "which insight wordings actually helped Jev on later questions", a direct RQ3
  diagnostic.

---

## 9. Shipping an optimized candidate

1. **New prompt IDs, never edits.** An accepted component becomes `predict.v2`, `jev-predict.v2`, `state.v2` in
   `packages/core/src/prompts.ts` and `docs/prompts/` (the docs-sync test enforces the mirror). The candidate JSON and
   the run's report are committed under `docs/prompts/runs/<id>.md` so the lineage is auditable.
2. **Config carries the versions.** `PipelineConfig.predictor` gains per-predictor prompt versions, e.g.
   `shadows: [{ id: 'llm:deepseek/deepseek-v4.1-flash', promptVersion: 'predict.v2' }]` and a `stateRenderer`
   version; `predictions.prompt_version` reads from config instead of the literal. Predictor IDs used as row keys
   become `llm:<model>@<promptVersion>` so two prompt versions of one model coexist as shadows. New config → new hash
   (`cfg.default.v3`), new mimics only; existing mimics keep theirs (ADR-0020's allocation rule).
3. **Backfill as the first online test.** `pnpm backfill --predictor llm:…@predict.v2` runs the new variant over every
   served question on the primary's sealed state blob (ADR-0024), so the within-person comparison against `predict.v1`
   is available in `/lab` the same day, on identical states.
4. **Promotion to primary path** (Jev templates, state renderer, post-processor) goes through an experiment arm, because
   it changes what people see and what the headline measures. A calibration post-processor is a config field with its
   fitted parameters and the fit's run ID; the stored prediction is the post-processed distribution (it is what the
   reveal shows) and the trace keeps the raw model output.
5. **Record an ADR** for each of: predictor IDs with prompt versions; the post-processing layer; sanctioning
   `--keep-identity` exports for local optimization runs (§10); the re-derivation mode's semantics.

---

## 10. Invariants and privacy checklist

| Invariant / rule | How this plan keeps it |
| --- | --- |
| 1 Sealed predictions | Candidates only re-render `buildState` output; the evaluator asserts `evidenceSeqMax < seq` on every record and the existing sealing test still runs |
| 2 Primary and baseline first | Untouched; optimization is offline, shipping is by config |
| 3 Evidence is the source of truth | `--rederive` recomputes derived state from evidence + candidate config, which is exactly what invariant 3 promises is possible |
| 4 Version everything | Records carry config hash, candidate hash, prompt version, model snapshot; shipped components get new IDs |
| 5 Log every call | Evaluator, reflection and cache hits all go through `Gateway`, with purposes `eval.evaluate`, `eval.reflect`, `eval.rederive` |
| 6 Baseline on | The evaluator always scores the context-only baseline on the same instances; lift is a reported column |
| 7 Consent and fixed splits | Export filters consent; splits are read from the export and enforced by the CLI (`test` refused for `optimize`) |
| 8 No cross-person data in prompts | Instruction-only optimization; leakage lint; no demos from real people; Twin data enters the *optimizer's* reflection context, never a production prompt |
| 9 Keys server-side | CLI only |
| PLAN §12.4 never tune on test | `optimize` refuses `--split test` and any `test` mimic in `--ids` |

**Scrubbed vs identity-keeping exports.** The scrubbed export replaces names with `Participant`, blanks the location and
drops `livesIn`/`headline` facts, so identity blocks differ from the online states and the context-only baseline is
weaker offline than online (lift is overstated). Twin data has no identities anyway. Proposal: optimize on scrubbed
exports; for the in-domain *validation* numbers use a local `--keep-identity` export (ADR-0018 already sanctions it for
internal reproduction; the ADR in §9.5 extends that to validation runs), never committed, never shared, with the
leakage lint active. The reflection model then sees no real names at all.

---

## 11. Milestones

### M9 Evaluator and baseline report

- `PromptComponents` refactor in `packages/core` (incumbent renders byte-identical; snapshot test).
- `mimic-eval evaluate` (modes `online`, `checkpoint`, `heldout`; `--from stored`; `--repeat`; JSONL records with
  feedback; summary; paired deltas; `eval_cache`).
- `mimic-eval diagnose`.
- Baseline report on the two real sessions, published to `/lab`.

**Accept:**
- [ ] The incumbent candidate reproduces the stored online scores within `REPRODUCTION_TOLERANCE` on a
      `--keep-identity` export (re-using `replay --mode online` logic).
- [ ] Offline tests with fakes cover: record schema, feedback construction (why, baseline, similar answers, repeat
      agreement), cache hits with a zero-cost `model_calls` row, refusal of `test` mimics, sealing assertion.
- [ ] The baseline report shows all five predictors per person and per type, self-consistency, lift, ECE and the
      noise floor, with no live calls needed for the stored variant.
- [ ] `diagnose` output for the Jev primary and one shadow is reviewed and its findings recorded in `VALIDATION.md`.

### M10 Optimizer, first runs, shipping path

- `mimic-eval optimize` with Pareto sampling, minibatch reflection, acceptance margin, leakage lint, checkpoint/resume.
- Config and ID changes from §9 (prompt versions per predictor, `llm:<model>@<promptVersion>`), backfill support.
- Runs: (a) Jev templates and state shape on Twin dev, validated LOPO on the real dev person(s); (b) `predict.*` for
  DeepSeek V4.1 Flash (the default LLM) with the `probs` and `{reasoning, probs}` schemas.

**Accept:**
- [ ] Offline end-to-end test with fakes: a seeded run accepts at least one child, resumes from its checkpoint, and the
      lint rejects a child containing a training question verbatim.
- [ ] Each run report states: budget used, cost by purpose, noise floor, val delta with CI, LOPO delta per real
      person, Twin dispersion ratio before and after, and the final candidate's full text.
- [ ] A winning `predict.v2` (if any) is shipped as a shadow via backfill and appears in `/lab` beside `predict.v1` on
      the same questions. If no candidate beats the noise floor, that result is reported as such.

### M11 Calibration and ensembles

- Temperature scaling per predictor and question type; shrinkage toward baseline; Jev+LLM log-linear pool, all fitted on
  Twin dev, checked LOPO on real, stored as versioned post-processors in config.

**Accept:**
- [ ] ECE and log loss improve on Twin test and on both real people for at least one post-processor, with accuracy
      unchanged within noise; the fitted parameters and fit run ID are in the config row.

### M12 Re-derivation

- `replay --rederive`: at each checkpoint, recompute trait reads and reflections from evidence with the candidate's
  components and models (queued jobs run inline, as the CLI session does), build the state from the recomputed derived
  data, predict, score. Cost-capped and cached.
- Runs: E2 state ablation with rederived states; E4 reflector prompt optimization against downstream Jev log loss, with
  the dispersion guard.

**Accept:**
- [ ] With the incumbent config, rederived states match the pinned states' evidence sections exactly and their
      derived sections within a reported tolerance (Jev trait reads are not deterministic).
- [ ] E2 and E4 reports published; RQ3 has a first answer with the stereotyping guard reported.

### M13 Generator

- Composite metric per generated batch: schema-valid rate, gate pass rate (Jev gates at `gates.v2` thresholds),
  dedupe survival, predicted-answer entropy under the current state (a question whose answer Jev already predicts at
  0.9 teaches nothing), facet coverage of targets, plus a human spot-check of 30 questions per accepted candidate.
- Optimize `gen.system`; ship as `gen.v2` in a new config used by an arm (E5 machinery).

**Accept:**
- [ ] The gate calibration set is tracked in the repo (§1.1) and the gate thresholds are re-checked on the current Jev
      snapshot before the generator run.
- [ ] A `gen.v2` arm reaches the same or better fidelity at 20 questions with fewer discarded candidates per refill, or
      the run reports why not.

---

## 12. Cost and time

Per-prediction costs from `VALIDATION.md` (M2 live run) and ADR-0024: Jev ≈ $0.0001 per question at typical state
sizes (input-only pricing), GPT-6 Luna ≈ $0.00025, DeepSeek V4.1 Flash ≈ $0.0003, GLM 5.3 Flash ≈ $0.0006,
MiMo ≈ $0.0001–0.0007.

| Run | Calls | Cost | Wall time (concurrency 8) |
| --- | --- | --- | --- |
| Full pass, real sessions, Jev | ≈ 150 | < $0.05 | ≈ 1 min |
| Full pass, real sessions, one LLM | ≈ 150 | ≈ $0.05 | ≈ 2 min |
| Full pass, Twin val (150 people × up to 40 held-out items, one checkpoint), Jev batched | ≈ 150 | ≈ $0.10 | ≈ 2 min |
| Full pass, Twin val, one LLM | ≈ 6,000 | ≈ $2 | ≈ 1 h; use minibatches, cache, and val on accepted children only |
| GEPA run, Jev components, 400 metric calls | — | ≈ $5 including reflection | an afternoon |
| GEPA run, LLM prompt, 400 metric calls | — | ≈ $30–60, mostly reflection and val passes | a day |
| Re-derivation pass, one person, 3 checkpoints | ≈ 3 reflections + 3 trait reads | cents | minutes |

The reflection model dominates: budget it explicitly (`--max-reflection-usd`) and log it under its own purpose.

---

## 13. Risks

- **Person-specific prompts.** The central failure mode with two people. Mitigations: train on Twin, LOPO on real, the
  leakage lint, the per-person overfit flag, the dispersion guard, and shipping only via shadows first.
- **Goodhart on Twin.** Twin items are survey items; a prompt tuned to Likert-style matrices may not help scenario
  questions. Mitigation: real sessions decide; report per-type; keep the Twin subsample stratified by item type.
- **Noise-driven acceptance.** Mitigation: measured noise floor and margin; repeat evaluation of the final candidate.
- **Optimizing the reveal effect away.** People who see the mimic's guess may answer differently (PLAN §16). The stored
  `revealed_prediction` flag lets the evaluator report both subsets; do not merge sessions with `reveal = never` into
  the same estimate silently.
- **Provider drift.** Model snapshots are part of every record; a run is only comparable to runs on the same snapshot.
  Re-run the incumbent when a snapshot changes (as ADR-0015 already requires for the gates).
- **Cost creep on Twin with LLM shadows.** Cache, minibatches, and Jev-first ordering keep it bounded; the CLI refuses
  to start a run whose worst-case cost exceeds `--max-usd`.
- **Small-n over-interpretation.** Every report prints n, per-person results, the noise floor and CIs next to any delta.

---

## 14. Decisions to confirm

| # | Decision | Decided (v1) |
| --- | --- | --- |
| 1 | Language of the optimizer loop | TypeScript in `packages/eval`, running the real engine code |
| 2 | Reflection model | `anthropic/claude-sonnet-5.5` on OpenRouter, low effort; `--reflection-model` overrides; never in a production config |
| 3 | Training data for optimization | Every consented dev person in the given files (prod export, plus Twin-2K-500 if added); by person with ≥ 6 dev people, else by question; test people are the holdout only |
| 4 | First optimization target | Jev's `jev.instructions` and `jev.choice` (default for `decision:` seeds); `predict.system` and `predict.user` for `llm:` seeds |
| 5 | Identity in local validation runs | Scrubbed exports everywhere by default, including Actions; `--keep-identity` stays reserved for the reproduction check |
| 6 | Predictor ID format for prompt variants | `llm:<model>@<version>` and `decision:<model>@<version>` (built; `jev:` until ADR-0054) |
| 7 | Where calibration lives | Fits are reported (`evaluate --from stored`); applying one online is a later config field |

---

## 15. References

- GEPA: Agrawal et al., *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*, 2025
  (arXiv:2507.19457); library and adapter protocol at https://github.com/gepa-ai/gepa (`evaluate`,
  `make_reflective_dataset`, `EvaluationBatch{outputs, scores, trajectories, objective_scores}`); DSPy's `dspy.GEPA`
  (`reflection_minibatch_size` default 3, `candidate_selection_strategy` `pareto`|`current_best`, `auto`
  light/medium/heavy).
- TypeScript ports: `@ax-llm/ax` `AxGEPA`/`optimize()` (Ax programs only); `gepa-ts` (archived April 2026).
- Twin-2K-500: Toubia et al. 2025, *Marketing Science* database report (arXiv:2505.17479). Test–retest accuracy
  81.7 % across 17 tasks; twin accuracy 71.7 %, i.e. 88 % of the ceiling; persona formats (text, JSON, summary) span
  67.9–71.9 %.
- Mega-study: Peng, Toubia et al. 2025, *A Mega-Study of Digital Twins Reveals Strengths, Weaknesses and Opportunities
  for Further Improvement* (arXiv:2509.19088): 19 studies, 164 outcomes; twin–human correlation ≈ 0.2; twins less
  variable than people; individual accuracy ≈ 75 % but not better than demographics-only personas.
- Persona structure: Ye, Deng, Candogan 2026, *Beyond Raw Transcripts: Structured Persona Extraction for LLM-Based
  Digital Twins* (arXiv:2608.20344): a structured schema beats raw transcripts by ≈ 1.9 points on Twin-2K-500;
  summarizing does not hurt, structure helps.
- Substitutability: Wang, Hunt, Tang, Joseph 2026, *When Can LLM Digital Twins Reduce Human Measurement?*
  (arXiv:2609.07987): twins reproduce averages, say little about which individuals differ.
- Calibration: Tian et al. 2023 (EMNLP), *Just Ask for Calibration*: verbalized confidences of RLHF models are often
  better calibrated than token log probabilities; temperature/Platt scaling as the standard post-hoc fix.
- Jev: OpenRouter Decisions API docs (`/api/alpha/decisions`, 32K context, input-only billing, `usage.cost`); Langfuse,
  *Using TypeSafe's Jev for evals* (2026-09-18): accuracy drops as the state fills with material the question does not
  need. OpenRouter chat parameters: `logprobs`, `top_logprobs`, `reasoning`.
