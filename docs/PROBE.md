# E7: the held-out probe set

v1 · 2026-10-01 · Status: designed, not run. ADR-0062. Decides E3b's yardstick. Readout to come in
`docs/reports/e7-probes.md`.

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

A fixed, versioned bank in `packages/core/src/probes.ts`, mirrored to `docs/ontology/probes.v1.json`. Items are
typed questions (choice, noul, score) in Mimic's own scenario style, never survey prose, except where noted.

| Tier | Distance | Items | How they are made |
| --- | --- | --- | --- |
| T0 | Repeat | 2 per person | An anchor and an adaptive question the person answered before answer 10, asked again at 30 (test-retest; the fidelity ceiling) |
| T1 | Near: same template | 3 | A fixed decision template Mimic also asks (a trade-off between two concrete options on a facet), with new content; the asked question that shares the template is logged so the distance is known per person |
| T2 | Mid: same facet, new scenario | 3 | A new scenario on a facet the person was asked about, chosen at ask time from the facets their first 10 answers covered |
| T3 | Far: an uncovered facet | 3 | A scenario on a facet no question covered by the time it is asked (selection's coverage map says which); fixed set per category |
| S | Shared with item means | 3 | The same three items for everyone, two of them Twin-2K-500 items with public answer distributions (CC BY 4.0), so lift over the item mean exists from the first person |

T1–T3 are drawn from a bank of about 60 items, 15 per category (`psychology`, `values`, `life`, `work`), none on a
sensitive facet. Every person gets the same S items and a fixed draw of T1–T3 per category seeded by `hash(mimicId)`,
so the set is stable per person and balanced across people.

## 3. Schedule

Probes are served at fixed positions, the same for everyone, interleaved with adaptive questions:

| After adaptive answers | Probes | Reads |
| --- | --- | --- |
| 0 (right after intake) | S1, T3a | The prior: what the context alone predicts |
| 10 | T1a, T2a, S2 | Early learning |
| 20 | T1b, T2b, T3b | |
| 30 | T0 × 2, T1c, T2c, T3c, S3 | The yardstick point for E3b |

Fourteen probes in a 30-question session, about four minutes. Each probe is predicted by the primary, the baseline
and every shadow before it is shown, exactly like any question (invariants 1, 2 and 6), and its answer becomes
evidence afterwards. Probes carry `kind: 'probe'`, are never selected, never generated, and are excluded from
selection's belief update only in the `probe-blind` arm (§6).

## 4. Metrics

All paired by question with intervals over people (2,000 seeded bootstraps, 90%).

- **Lift by tier:** Δ log loss and Δ item accuracy against the context-only baseline, per tier and per position.
- **Residual lift (S items):** Δ against the item-mean predictor, from the stored distributions; across-person
  correlation and dispersion ratio on S and T3 items (PLAN §12.3).
- **Ceiling:** T0 self-consistency per person; fidelity on probes = accuracy ÷ consistency.
- **Calibration by position:** ECE at 0, 10, 20 and 30 answers, since one temperature does not hold across state sizes.
- **State-insensitive items:** the share of probes on which the primary's distribution does not change between the
  context view and the served view (the Twin probability tasks were 12% of items and carried nothing).
- **Yardstick power:** the per-person SD of T2+T3 lift at 30, which gives E3b's sample size.

## 5. Decision rule (`PROBE_RULE`, fixed before the first readout)

- **Answers help at tier t** when the tier's Δ log loss interval against context is below 0 and accuracy does not fall.
- **The mimic individuates** when the S-item across-person correlation exceeds the context view's by 0.05 with the
  interval above 0, or dispersion rises by 0.1.
- **E3b may start** when T2+T3 lift at 30 is measured on at least 30 people and its per-person SD gives E3b a
  detectable effect of 3 points or less with 64 people per arm; otherwise E3b waits for more people or a larger
  probe set.
- **A tier that never helps** (T3 at 30 with the interval above 0 on 60 people) sends the work to generation and
  compaction before selection: the state does not carry what it would need.

Outcomes are written as the rule gives them. Nothing is tuned on probe answers.

## 6. Arms and what else E7 carries

E7 is a measurement, not a comparison, but it is cheap to carry two pre-registered checks:

- **`probe-blind`:** for half the people, probe answers do not enter the belief state used by selection (they still
  enter the predictor's evidence). This measures whether the probes' own answers change what is asked next.
- **Views on probes:** every E6 view (`answers`, `derived`, `relevant`) and the `card` (ADR-0056) are scored offline
  on the same probes from the stored states, so the state-form question gets the yardstick E6 lacked.

## 7. What it can't show

- Probes are Mimic-style scenarios on ontology facets. A domain the ontology lacks is not probed.
- Fourteen probes per person: at 30 people, each tier-position cell holds 30–90 answers, enough for 5-point effects;
  2-point effects need about 100 people. The rule says so instead of over-reading.
- The S items from Twin are survey prose and may behave like Twin's items did, not like Mimic's.
- Serving probes lengthens the session by four minutes and may lower completion; the session UI shows them as
  ordinary questions.

## 8. Cost and rollout

- No new model spend beyond the usual predictions per question; about $0.01 per person at today's rates.
- Ships behind the `probe-set` flag (ADR-0051; default off), on by default once the bank is reviewed. Needs: `probe`
  in `QKind`, the bank and its schedule in core, a selector wrapper that serves the next due probe, `pnpm eval --
  probes` for the readout, and a /lab panel. Scripted sessions prove the machinery; nothing from them is a result.
- Readout: `docs/reports/e7-probes.md`, written as the rule gives it.
