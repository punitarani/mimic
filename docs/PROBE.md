# E7: the held-out probe set

v1.1 · 2026-10-01 · Status: built, not run. ADR-0062. Decides E3b's yardstick. Set it up from the `e7` preset in
`/lab` (draft; starting it is a person's decision), read it with `pnpm eval -- probes`, and write the readout in
`docs/reports/e7-probes.md`. §2 and §3 describe what was built; §9 lists where it differs from v1 of this design.

E6 (`docs/EVIDENCE.md`, verdict `questions`) and the Twin benchmark (`docs/reports/twin-benchmark.md`) left Mimic
without a way to measure what a mimic has learned about a person. Next-question accuracy measures the prior, because
selection moves each question to what is least known; Twin's held-out items measure transfer from demographics and
personality scales to product choices, which Mimic's intake already covers. E7 asks every person the same small set of
items at known distances from what they were asked, predicts each from the sealed state before it is shown, and reads
learning per distance.

## 1. Questions

- **Q1, distance.** At which distance from the asked questions do a person's answers improve the prediction: a repeat
  of an asked item, a new item on the same decision template, a new scenario on the same facet, or a facet no question
  covered?
- **Q2, individuation.** On items everyone answers, does the mimic track the person (across-person correlation,
  dispersion, lift over the item mean), or the stereotype?
- **Q3, the yardstick.** Can probe lift at 30 answers separate two selection strategies that next-question fidelity
  cannot (E3b)?
- **Q4, the ceiling.** What is each person's test-retest consistency on the probes, so fidelity has a per-person
  denominator that does not depend on which questions selection chose?

## 2. The probe bank (`probe.v1`)

Probes are drawn from the config's reserve bank (reserve.v2: 88 hand-written, concrete items, 66 on non-sensitive
facets), never from generated questions, so every probe is a plainly worded scenario in Mimic's own style. Distance
is measured, not assumed: when a probe is served, its tier is read from how many of the person's answers touch its
facets (its `load`).

| Tier | Distance | Per person | How it is chosen |
| --- | --- | --- | --- |
| `repeat` | The same item | 2 | The earliest answered anchors, asked again at the last slot: test-retest consistency, and prediction when the state holds the person's own earlier answer |
| `near` | Two or more answers on one of its facets | 3 | An unused bank item at that load |
| `mid` | Exactly one answer on its facets | 3 | An unused bank item at that load |
| `far` | No answer on its facets | 3 | An unused bank item at that load |
| `shared` | The same item for everyone | 3 | `reserve.v2/need_for_cognition_1` (psychology), `norm_compliance_1` (values) and `forgiveness_1` (life); the selector never offers them, so they are first asked at their slot |

A tier with no item left is served at the nearest tier that has one (`near` falls back to `mid`, then `far`), and the
probe records both the tier planned and the tier served; the readout groups by the tier served. Probes never touch a
sensitive facet, a facet outside the person's scope, or a workplace scene for someone without "Work and money". The
choice within a tier is seeded by the person and the slot, so it is stable and spread across people. The shared items'
item means come from the cohort itself (leave-one-out, five other people at least); no external distribution enters.

## 3. Schedule

Probes are served at fixed points, the same for everyone. A slot opens once the person has answered that many other
session questions (anchors, adaptive questions and repeats), so slot 30 opens where a default (v8 or v9) session reaches
its target:

| After other answers | Probes | Reads |
| --- | --- | --- |
| 0 (right after intake, before the anchors) | shared, far | The prior: what the context alone predicts |
| 10 (after the anchors) | near, mid, shared | Early learning |
| 20 | near, mid, far | |
| 30 | repeat × 2, near, mid, far, shared | The yardstick point for E3b |

Fourteen probes; `cfg.e7.probes` raises the session target from 30 to 44 and the session budget from $0.50 to $0.75.
Each probe is a question of kind `adaptive` with `provenance.generator = 'probe'` and its tier, slot and load in
`quality.probe`. It is predicted by the primary, the baseline and every shadow before it is shown, exactly like any
question (invariants 1, 2 and 6), its answer becomes evidence afterwards, and it is never selected or generated: the
selector's pool and the reserve top-up both leave probes and shared items out. A repeat that the existing repeat
schedule asks of a probe is a repeat, not a probe.

## 4. Metrics

All paired by question with intervals over people (2,000 seeded bootstraps, 90%).

- **Lift by tier:** Δ log loss and Δ item accuracy against the context-only baseline, per tier and per position.
- **Residual lift (shared items):** Δ against a leave-one-out item mean from the cohort; across-person correlation
  and dispersion ratio on the shared items (PLAN §12.3).
- **Ceiling:** repeat consistency; probe fidelity = the primary's accuracy on probes ÷ consistency.
- **Calibration by position:** ECE at 0, 10, 20 and 30 answers, since one temperature does not hold across state sizes.
- **State-insensitive items:** the share of probes on which the primary's distribution does not change between the
  context view and the served view (the Twin probability tasks were 12% of items and carried nothing).
- **Yardstick power:** the per-person SD of mid and far lift at the last slot, which gives E3b's detectable effect.

## 5. Decision rule (`PROBE_RULE`, fixed before the first readout)

- **Answers help at tier t** when the tier's Δ log loss interval against context is below 0 and accuracy does not fall.
- **The mimic individuates** when the shared-item across-person correlation exceeds the baseline's by 0.05 with the
  interval above 0 (resampling people), or dispersion rises by 0.1.
- **E3b may start** (`e3b-ready`) when mid and far lift at the last slot is measured on at least 30 people and its
  per-person SD gives E3b a detectable effect of 3 points or less with 64 people per arm (2.8 × SD × √(2/64));
  otherwise E3b waits for more people or a larger probe set.
- **A tier that never helps** (far probes at the last slot with the log-loss interval above 0 on 60 people,
  `compaction-first`) sends the work to generation and compaction before selection: the state does not carry what
  it would need.
- Under 30 people with probes the verdict is `insufficient`; otherwise `measuring` until one of the above holds. The
  constants are `PROBE_RULE` in `packages/eval/src/probes.ts`.

Outcomes are written as the rule gives them. Nothing is tuned on probe answers.

## 6. Arms and what else E7 carries

E7 is a measurement, not a comparison, but it is cheap to carry two pre-registered checks:

- **`probe-blind`** (not built in v1.1): for half the people, probe answers would not enter the belief state used by
  selection. Probe answers do inform selection today, as any answer does.
- **Views on probes:** `pnpm eval -- evidence --probes-only` runs E6's views (`context`, `full`, `answers`,
  `derived`, `relevant`) on served probes alone, so the state-form question gets the yardstick E6 lacked. The card
  (ADR-0056) is not one of E6's views; `replay --state card` covers it.

## 7. What it can't show

- Probes are Mimic-style scenarios on ontology facets. A domain the ontology lacks is not probed.
- Fourteen probes per person: at 30 people, each tier-position cell holds 30–90 answers, enough for 5-point effects;
  2-point effects need about 100 people. The rule says so instead of over-reading.
- Three shared items are few: across-person correlation on them is noisy until many people have answered, and
  their item means need five other people before the residual can be read.
- Serving probes lengthens the session by four minutes and may lower completion; the session UI shows them as
  ordinary questions.

## 8. Cost and rollout

- No new model spend beyond the usual predictions per question: fourteen more served questions per person.
- Ships as a config and a `/lab` preset, not a flag: the probes are part of what a person is asked and what the mimic
  is measured on, so they are versioned in the config (`cfg.e7.probes`), and only runtime levers are flags
  (ADR-0052). Setting up the `e7` preset registers the config and saves a draft experiment with one arm; starting it
  sends new people to it, and stays a person's decision. Older mimics and the default config are unchanged. Since
  ADR-0065 and ADR-0066 the config is the default (v10) with the probes, so the view shadows (Jev on derived data,
  DeepSeek on the context) and the scale shadow are read per distance too.
- Readout: `pnpm eval -- probes --data <export>` (no model calls), then `docs/reports/e7-probes.md`, written as the
  rule gives it. Scripted sessions prove the machinery; nothing from them is a result.

## 9. What changed from v1 of this design

- Distance tiers are measured from the person's answers on the item's facets (near, mid, far), not from a hand-made
  template map; a planned tier that cannot be filled is served at the nearest one and recorded as such.
- The bank is the reserve set, not a new 60-item bank, and the shared items are three reserve items with item means
  from the cohort, not Twin-2K-500 items (Twin's held-out items are survey prose and mostly product choices).
- Probes are `adaptive` questions marked by their generator, not a new question kind, so every existing path
  (sealing, shadows, scoring, exports, undo) handles them unchanged.
- The clock counts every other session answer, repeats included, so the last slot lines up with v8's target.
- No flag and no `probe-blind` arm; see §6 and §8.
