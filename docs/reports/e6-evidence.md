# E6 readout: what the mimic learns from (ADR-0053)

The design and the rule were pre-registered in `docs/EVIDENCE.md` before this run.

## The run

| | |
| --- | --- |
| Workflow | Actions → Evidence, run `36800696803` on `641dcae`, 2026-10-01 01:21–01:47 UTC |
| Eval run | `01M3TJAEA5H0GB75D8Z11Q4MMA` (in /lab → Eval runs) |
| Served data | The prod export: 6 consented people and 330 served questions. One person without research consent was dropped, and one special-category question withheld. |
| Twin data | Twin-2K-500: 100 people, 20 held-out items each, at k = 10, 30 and 100 answers |
| Jev | `jev:typesafe/jev-1.13@jev-predict.v2`, snapshot `typesafe/jev-1.13-20260917`; all five views |
| DeepSeek | `llm:deepseek/deepseek-v4.1-flash@predict.v2`, served by Wafer; `context`, `full` and `answers`, on served questions and 40 Twin people at k = 30 |
| Spend | $2.07 of the $4 cap. All 26 cells ran, with no failed predictions. |

## Verdict (EVIDENCE_RULE): `questions`

> Jev learns from survey answers but not from Mimic's: the questions asked are the limit. Next: generation and
> selection, before E3b's between-people arms.

Each row compares the `full` view (the state as served) with the `context` view (no answers), for the same predictor
and the same questions.

| Predictor | Data | Δ log loss [90% CI] | Δ item accuracy, points [90% CI] | People better / worse | Learns |
| --- | --- | --- | --- | --- | --- |
| Jev | Served (330 questions, 6 people) | −0.024 [−0.065, +0.019] | +0.1 [−3.7, +4.3] | 3 / 3 | no |
| Jev | Twin, k = 30 (2,000 questions, 100 people) | −0.039 [−0.058, −0.021] | +2.1 [+0.2, +4.2] | 65 / 35 | yes |
| DeepSeek | Served | +0.024 [−0.032, +0.081] | +1.6 [−3.1, +6.1] | 1 / 5 | no |
| DeepSeek | Twin, k = 30 (800 questions, 40 people) | −0.056 [−0.097, −0.013] | +5.2 [+3.0, +7.6] | 24 / 16 | yes |

Served intervals are by question, and Twin's by person.

**No view replaced `full` for the primary.** Against `full` on served questions:

| View | Δ log loss [90% CI] | People better | Δ item accuracy, points |
| --- | --- | --- | --- |
| `answers` | −0.002 [−0.026, +0.021] | 2 of 6 | +0.8 |
| `derived` | +0.010 [−0.018, +0.038] | 2 of 6 | +4.8 |
| `relevant` | −0.005 [−0.034, +0.023] | 3 of 6 | +1.1 |

On Twin at k = 30, `relevant` against `full` was +0.002 [−0.007, +0.009].

## What it shows

1. **Both predictors can use answers.**
   - On Twin, answers lower log loss and raise accuracy for Jev and DeepSeek alike.
   - Jev's accuracy gain grows with the number of answers: −0.2 points at k = 10, +2.1 at k = 30, +6.2 at k = 100.
   - Answers also individuate, as the mega-study of digital twins found. At k = 30, across-person correlation rose
     from 0.18 to 0.24 for Jev and from 0.24 to 0.34 for DeepSeek. Predictions also spread out: dispersion went from
     0.08 to 0.19 for Jev and from 0.26 to 0.46 for DeepSeek.
2. **Mimic's answers don't measurably help predict Mimic's next question.** Neither model gains on served questions.
   - Six people can rule out a large gain, not a Twin-sized one: Jev's served interval (−0.065 to +0.019) still
     contains Twin's −0.039.
   - The served buckets by answers held (0–9, 10–19, 20–39, 40+) move up and down with no trend. Each holds 60–109
     questions.
3. **Why Twin and not Mimic.** Twin's held-out items repeat batteries that waves 1–3 already asked: personality
   scales, economic preferences and the like. Earlier answers bear directly on them. Mimic's selection does the
   opposite on purpose: value of information, M12's category balance and the coverage deadlines move each question
   to what is least known. The next question is then mostly about something no answer covers, and next-question
   accuracy measures the prior. "The questions are the limit" has two parts:
   - the answers collected carry little about the next question;
   - next-question accuracy is a weak ruler for what the mimic has learned, because selection aims at what it hasn't.

   One caveat cuts the other way. Twin's wave 4 repeats some earlier tasks to measure test–retest reliability, so for
   some held-out items the state may hold the person's own earlier answer to the same item. That raises Twin's lift
   above what new questions would show.
4. **The LLM shadows' lift in /lab was mostly a better prior.** This is exploratory: the rule makes no
   between-model comparison, and the run has no interval for it.
   - With context alone, DeepSeek already beats every Jev view on served questions: log loss 1.119 against Jev's
     best of 1.143, and item accuracy 57.9% against Jev's 55.6% from the same context.
   - Its own answers add little: +1.6 points with `full`, +0.6 with `answers`.
   - The 2–7 point lift /lab shows for the LLM shadows is measured against Jev's baseline, so it mixes a better prior
     with learning. E6 puts most of it in the prior.

## Exploratory

These were not pre-registered, and no decision rests on them.

- **`derived` and Jev's accuracy.** Traits and insights without the answers raised Jev's served item accuracy by 4.8
  points over `full` [+2.2, +7.5] and 5.0 over `context` [+1.0, +8.8]. Log loss didn't improve (+0.010), and only 2
  of 6 people got better. It is one of several views tried, so it needs new people before it means anything.
- **Derived data hurts DeepSeek's calibration.** On served questions DeepSeek did better without traits and insights:
  log loss 1.099 for `answers` against 1.143 for `full`, and ECE 0.088 against 0.117.
- **Calibration drifts with long states.** At T = 4, Jev's ECE on Twin was 0.042 at k = 30 and 0.120 at k = 100. So
  at k = 100 its log-loss gain shrinks (−0.012) while its accuracy gain grows (+6.2). T was fitted on served states
  of up to about 90 answers.
- **`relevant` is cheaper.** On Twin at k = 30 it matched `full`'s log loss with 2.5 more points of accuracy [+0.7,
  +4.2], on about a third of the tokens (774 against 2,566). At k = 10 it lost 1.4 points.
- **Served individuation can't be read.** Its across-person numbers rest on 6 shared items (the anchors).

## Checks

- **Top picks.** E6 agreed with production's stored predictions on 89.4% of served questions for the baseline and
  95.5% for the primary. Production asked each question in a batch of candidates; E6 asks one at a time.
- **State hashes matched 0%, and nothing is wrong.**
  - The workflow exports scrubbed data: names become "Participant", and locations, employers, links and place facts
    are removed (ADR-0018). No rebuilt state can therefore hash-match what production served.
  - The pre-registration's "same state hash" check holds only on an internal `--keep-identity` export (ADR-0018).
    `docs/EVIDENCE.md` and the report now say so.
  - Every served arm saw the same scrubbed identity, so comparisons within the run stand.
  - The served `context` arm saw less than production's baseline did: occupation and the remaining sourced facts,
    without name or location.
- **Data.** Every arm in a dataset scored the same questions. Identical views were served from the cache and counted
  $0.

## Next

Following the pre-registered outcome, E3b stays a draft. Generation and selection come first, and the measurement
before either:

1. **A held-out probe set (proposed as E7).** A fixed set of items, asked of everyone and predicted from the sealed
   state, like Twin's wave 4. It would:
   - measure what the mimic knows, apart from what selection chooses next;
   - give across-person correlation on shared items;
   - let selection strategies be compared on one yardstick.

   This is what E3b needs before its 128 people mean anything.
2. **Selection that also exploits.** Value of information asks what is least known. A share of questions on facets
   already estimated would let answers inform predictions, and that is what next-question fidelity rewards. E7
   would measure both.
3. **Follow-ups.**
   - Re-run E6 as consented people accumulate (about $2 a run).
   - Shadow two exploratory leads on new people before acting on either: `derived` for Jev's accuracy, and DeepSeek's
     context-only prior.
