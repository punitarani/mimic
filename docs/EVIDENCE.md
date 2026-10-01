# E6: what the mimic learns from

v1 · 2026-10-01 · Status: run on 2026-10-01 (eval run `01M3TJAEA5H0GB75D8Z11Q4MMA`, $2.07). Verdict: `questions`.
Readout: `docs/reports/e6-evidence.md`. ADR-0053. Re-run from Actions → Evidence as people accumulate. What the
run could not show, and what E7 does about it: §8 and `docs/PROBE.md` (ADR-0062).

E6 asks whether the mimic's predictions improve with a person's answers, and which form of those answers a predictor
actually uses. Every arm predicts the same sealed questions, so it is a within-person, paired experiment. It needs no
new people, costs about $2, and runs in one workflow.

## 1. Why this experiment, and why now

### What the lab shows

These numbers come from the stored-predictions report of 2026-09-30 23:50 (Actions → Optimize, run
`01M3TBKNHC0AMKWBMYPM01SD3B`): 6 consented people and 330 scored questions.

- **The primary barely beats its own context-only baseline.** The baseline sees intake and sourced facts only, and
  no answers.

  | Primary | People | Questions | Item accuracy | Baseline | Lift |
  | --- | --- | --- | --- | --- | --- |
  | Raw Jev (configs v1–v6) | 4 | 215 | 56.6% | 55.6% | +1.0 |
  | The same predictions, calibrated | 4 | 215 | 56.9% | 55.6% | +1.3 |
  | Calibrated Jev, as served (v7, v8) | 2 | 115 | 54.6% | 59.3% | −4.7 |

  On the 76 choice questions served under v7 and v8, the primary scored 46.1% and the baseline 56.6%.
- **Every LLM shadow beats that baseline, by 2–7 points on the same questions.** DeepSeek `predict.v2` +4.0 (308
  questions), MiMo Flash +5.3, GPT-6 Luna +5.2, GLM +4.5 and MiMo Pro +6.8. Nobody has measured an LLM's own
  context-only prediction, so this lift mixes a better prior with learning from answers. E6 separates the two.
- **A log-linear pool gives Jev no weight.** Fitted against each of the ten LLM shadows, the weight on the primary
  came out 0.000 every time. Pooled with DeepSeek `predict.v2`, test log loss went from 1.804 (the primary alone) to
  1.106, and accuracy from 57.7% to 62.7%.
- **Fidelity doesn't climb.** /lab shows fidelity 69.9% at 20 questions and 63.6% at the end. One of six people
  reached 0.75 and stayed there.
- **Jev does fine on survey items.** On 25 test people (Twin-2K-500 and prod, 1,109 predictions, k = 30), the span-01
  benchmark measured Jev at log loss 0.90 and item accuracy 60.5%. What that number doesn't show is how much of it
  comes from the answers.

### What the research says

- **Twin-2K-500** (Toubia et al. 2025): digital twins built from about 500 answers reach roughly 72% accuracy on held-out
  questions, about 88% of the respondents' own test–retest accuracy. A dozen persona formats (text or JSON, summaries,
  reasoning) all landed in a similar range.
- **The mega-study of digital twins** (Peng, Toubia et al. 2025; 19 pre-registered sub-studies on the same people):
  individual accuracy of about 75% was *not significantly different from personas built from demographics alone*.
  Correlation with the real person's answers across people was low (about 0.2). It improved with detailed personal
  information, and that is where the personal data showed.
- **Generative agents of 1,000 people** (Park et al. 2024): agents built from two-hour interviews replicated General
  Social Survey answers 85% as well as the people themselves did two weeks later. That beat agents given demographics
  or short persona descriptions.

So the field's open question is Mimic's too. Answers beat demographics only when the predictor uses them, and
accuracy alone can hide individuation. E6 therefore reports across-person correlation and dispersion alongside
accuracy.

### Why E3b waits

E3b (ADR-0045) tests which questions to ask. Selection pays off only through a predictor that learns from the
answers. If the primary's served predictions don't beat its own context-only baseline, fidelity at 20 barely depends
on which questions were asked, and E3b's 128 people would measure noise. At the current rate (6 consented people so
far), those 128 people are months away. E6 needs none: it reuses the sealed states already stored.

## 2. Questions and hypotheses

- **Q1, use.** Does each predictor's prediction improve when it sees the person's answers?
  - H1: Jev's `full` − `context` log loss is below 0 on served questions. The lab suggests it isn't, and E6 tests it.
  - H5: The LLM's own `full` − `context` is below 0, and below Jev's.
- **Q2, form.** Which form of the answers does Jev use?
  - H2, clutter: `answers` beats `full`, because derived traits and insights dilute or contradict the answers.
  - H3, summary: `derived` does as well as `full`, which would mean the traits and insights carry the signal.
  - H4, relevance: `relevant` beats `full`. Jev's accuracy is reported to fall as the state fills with material the
    question doesn't need (docs/OPTIMIZATION.md §7, item 3).
- **Q3, dose and response.** If a predictor uses answers, its lift over `context` grows as answers accumulate (H6).
  E6 tests this on Twin at k = 10, 30 and 100, and on served questions by how many answers each state held.

## 3. Design

**Unit.** A sealed prediction: one person, one question, and the state built only from answers before it, with
derived data as of the moment it was served (invariant 1, ADR-0017).

**Arms.** A predictor and a view of the same sealed state (`viewState`, `packages/core/src/state-builder.ts`). Each
view is a subset of the state and never adds to it, so sealing holds by construction.

| View | What the predictor sees | Tests |
| --- | --- | --- |
| `context` | Intake and sourced facts only, as the stored baseline saw them (same state hash on an unscrubbed export) | The floor |
| `full` | The state as served: identity, traits, insights and answers | The incumbent |
| `answers` | Identity and the answers; no traits or insights | H2 |
| `derived` | Identity, traits and insights; no answers | H3 |
| `relevant` | Identity and the 8 answers most similar to the question (lexical similarity, ties to the latest) | H4 |

Predictors:
- **Jev:** the production primary, `jev:typesafe/jev-1.13@jev-predict.v2` (calibrated, T = 4; spelled
  `decision:typesafe/jev-1.13@jev-predict.v2` since ADR-0054, the same predictor). It gets all five views.
- **An LLM:** `llm:deepseek/deepseek-v4.1-flash@predict.v2`, the default LLM, with the best item accuracy among the
  `predict.v2` shadows. It gets `context`, `full` and `answers`, which is enough to separate its prior from its
  learning (H5).

**Datasets.**

| Dataset | Who | Questions | Note |
| --- | --- | --- | --- |
| Served | Every consented prod person, both splits | Every answered anchor and adaptive question, with the state as served | About 330 from 6 people today |
| Twin-2K-500 | 100 people (public survey answers from real people) | 20 held-out wave-4 items per person, from their first k wave 1–3 answers, at k = 10, 30 and 100 | Twin people have no traits or insights: `answers` equals `full` there, and `derived` equals `context` |

The LLM runs on served questions and on 40 Twin people at k = 30.

**Controls.**
- **One question per request** in every arm. Production asks Jev about a whole candidate pool at once. Here no arm
  differs from another by what else was in its batch.
- **Reproduction checks.**
  - On an internal `--keep-identity` export, the `context` arm's state hash equals the stored baseline's, and the
    `full` arm's equals the stored primary's.
  - The workflow's export is scrubbed (ADR-0018): names become "Participant", and locations, employers, links and
    place facts are removed. There no state can match, and the top-pick agreement below is the check that counts.
    Every arm sees the same scrubbed identity.
  - The report gives top-pick agreement with both stored predictions, so the effect of batching is visible.
- **No tuning.** Nothing is fitted or chosen on this data. The views, predictors, k values and rule are fixed here
  and in `EVIDENCE_RULE` before the first run.
- **Real people only.** Served people are real. Twin-2K-500 holds real survey answers. Scripted and simulated people
  are never counted.
- **Identical views cost nothing twice.** A view that shows the same state as another arm (for example `answers` on
  Twin) is served from the cache, and the report marks it "identical states".

## 4. Metrics

- **Primary: Δ log loss**, paired on the same questions, for each view against `context` (what the answers add) and
  for each Jev view against `full` (what would change for the primary). Log loss is a proper scoring rule and the
  most sensitive metric at this size.
- **Secondary:**
  - Δ item accuracy (the headline's ingredient);
  - top-1 and ECE;
  - across-person correlation per item, and dispersion (SD of predictions ÷ SD of answers; PLAN §12.3);
  - state tokens, cost and p50 latency;
  - people who improve or get worse.
- **Intervals.** All are 90% seeded bootstraps (2,000 resamples).
  - Twin: by person, resampling people, since questions from one person aren't independent.
  - Served questions: by question. Six people can't support an interval by person, so the rule also counts people.

**Sensitivity.** From earlier paired comparisons, the per-question SD of a log-loss difference is about 0.3–0.4 nats,
and of an item-accuracy difference about 30–45 points.
- Served (about 330 questions): the 90% interval's half-width is about ±0.035 nats and ±3–4 points. E6 can see a
  0.05-nat or 5-point effect, not a 2-point one.
- Twin (100 people × 20 items per k): about ±0.02 nats and ±1.5 points, before clustering by person widens it.
- Effects worth acting on are about 0.03 nats or 2 points. Twin can confirm those; on served questions E6 can only
  confirm larger effects, plus their direction per person.

## 5. Decision rule (`EVIDENCE_RULE`, `packages/eval/src/evidence.ts`)

**A view replaces `full` for the primary** only if, against `full`:

1. **On served questions:**
   - the Δ log loss interval (by question) is below 0;
   - at least two-thirds of people improve;
   - item accuracy drops by at most 1 point;
   - there are at least 200 questions from at least 5 people.
2. **On Twin at k = 30, for the views Twin can test** (`relevant`; Twin has no traits or insights, so it can't test
   `answers` or `derived`):
   - the Δ log loss interval (by person) is below 0;
   - item accuracy drops by at most 1 point;
   - there are at least 30 people.

If several views pass, the one with the lowest served log loss wins.

**A predictor "learns" on a dataset** when `full` − `context` has its log-loss interval below 0 (by question on
served questions, by person on Twin) and raises mean item accuracy. It is measured only with the data the view checks
need: at least 200 questions from 5 people on served questions, and 30 people on Twin. A predictor or dataset measured
with less (cut short by the spend cap, `--llm none`, no Twin data) is unknown, not a predictor that doesn't learn.

**Outcomes and what follows**, checked in this order:

| Outcome | When | Next |
| --- | --- | --- |
| `insufficient` | Fewer than 200 served questions from 5 people; or no view passes, Jev doesn't learn on served questions, and a measurement the next outcome depends on is missing or too small (the LLM on served questions, then Jev on Twin at k = 30) | Re-run when there are, or with the missing arm |
| `ship` | A view passes | Make the view a Jev prompt version (`jev-predict.v3`, a `stateView` harness setting applied in the predictors). Backfill it as a shadow (`pnpm backfill`) and read it in /lab on new people, then promote it in `cfg.default.v9` |
| `learns` | No view passes, but Jev learns on served questions | The primary is fine as is. Start E3b |
| `model` | Jev doesn't learn on served questions, and the LLM does | E7: an LLM or pooled primary that meets the sync-path latency target (p50 ≤ 800 ms; DeepSeek takes about 3.5 s, GLM about 1.6 s) |
| `questions` | Neither learns on served questions, and Jev learns on Twin | The questions Mimic asks carry little about the next one. Work on generation and selection before E3b's arms |
| `none` | Nothing learns anywhere | Check the harness (the reproduction checks first), then the questions |

## 6. What it can't show

- **Six served people.** Served intervals are by question, so a served effect generalizes to new people only as far
  as the per-person counts and Twin suggest. A `ship` outcome is confirmed online on new people as a shadow before
  any config change.
- **Twin items are survey items,** not Mimic's concrete scenarios. Twin decides whether a form of evidence can help;
  served questions decide whether it helps here.
- **Views are subsets of the served state, not rebuilt states.** `answers` doesn't add answers the token budget
  dropped. At up to about 90 answers the budget dropped none.
- **Calibration was fitted on `full`.** T = 4 may suit other views less well, which would count against them in log
  loss. Item accuracy and ECE are reported for that reason.
- **One LLM.** DeepSeek stands in for the LLMs. The stored shadows already rank the others.
- **`relevant` uses lexical similarity.** The export holds no embeddings. A null result for `relevant` says nothing
  about embedding retrieval, which `replay --per-target --embed` measures (ADR-0064).

## 7. Running it

1. Merge. The workflow runs only on `main`, with the production environment's secrets.
2. Go to Actions → Evidence → Run workflow and keep the defaults: data `both`, 100 Twin people, k `10,30,100`,
   DeepSeek for 40 Twin people, a $4 cap, and publish.
   - Cells run in priority order: Jev on served questions, Jev on Twin at k = 30, the LLM, then the rest of Twin's
     curve. A cap therefore cuts the least important cells first.
   - Expected spend is about $2: Jev about $0.0001 a request, DeepSeek about $0.0004 a question.
   - Expected time is 30–40 minutes.
3. Read the step summary, or the run under /lab → Eval runs, then write `docs/reports/e6-evidence.md`. Report the
   verdict as the rule gives it, not as hoped.

Locally, with an export:

```
pnpm eval -- export --env prod --out data/prod.sqlite
pnpm eval -- evidence --data data/prod.sqlite,data/twin.sqlite --max-usd 4
pnpm eval -- evidence --data data/prod.sqlite --llm none --offline   # checks the machinery only, for free
```

## 8. Limitations found after the run (2026-10-01)

The Twin benchmark (`docs/reports/twin-benchmark.md`, 60 imported people, replay and E6 on the same import) showed
what the first run's numbers rest on. Each point names what E7 (`docs/PROBE.md`) or the agenda (`docs/RESEARCH.md`
§10) does about it.

1. **Twin measures transfer from demographics and personality to product choices.** No held-out domain appears in a
   person's first 100 answers, which are nine demographics, the Big Five and materialism and empathy scales. 61% of
   the held-out items are product choices and they carry 96% of the lift at k = 100. Party and ideology carry the
   policy items (+4.4 points while the state holds them, +1.2 once it has dropped them). Mimic's intake already puts
   demographics in the context view, so "Jev learns on Twin" and "Jev doesn't learn on served questions" partly
   measure the same thing from two sides: on Twin the answers supply what the served baseline already knows. The two
   datasets are not one experiment with two outcomes. E7 asks the same items of everyone at known distances.
2. **Served questions measure the far end only.** Selection moves each question to what is least known, so every
   served question is a far-transfer item. Twin's are mid-distance items whose predictors sit early in the answer
   order. Neither dataset measures near transfer, and nothing measures all three on one person. That is E7's tiers.
3. **Six people decide nothing smaller than 5 points.** The served interval half-width was 0.042 nats on 330
   questions; a Twin-sized effect (0.039) needs about four times the questions, about 25 consented people at the
   current rate of 55 questions each. The rule's "learns" is unknown, not "no", until then.
4. **What the state keeps decides what it can learn.** Beyond the §9.9 budget the Twin state held the 18 most recent
   answers (the replay and this run's Twin arm build states with no target to retrieve for, where production
   retrieves by similarity to the candidate batch). Recency is domain-blind: the oldest answers were the ones that
   carried the policy items. Word overlap does not find them ("party" shares no words with "a carbon tax"), so
   `relevant` is limited by its distance measure. Embeddings do: retrieved per target by embeddings, the policy lift
   at 100 answers rises from +1.6 to +4.4 points, and a state that then fills the budget (`fill`, ADR-0064) is the
   best measured (`docs/reports/twin-benchmark.md`).
5. **Some items are state-insensitive.** On Twin's probability tasks (12% of items) Jev's prediction is identical for
   every view. A view comparison counts those as ties and dilutes every effect by their share. Report them apart.
6. **Calibration is a function of state size.** T = 4 gives ECE 0.036 at 10 and 30 answers and 0.111 at 100 on Twin.
   A view that changes the state's size changes its calibration, and log loss then mixes the two. The fix is a
   temperature by evidence count, fitted prequentially (`evaluate --from stored` fits one per band).
7. **Jev reads summaries better than answers.** `derived` gave Jev +4.8 points on served questions and no log-loss
   gain; the core SOUL.md (a DeepSeek narrative of 30 answers, no answers) gave the Jev reader +3.7 over the state
   text on 60 Twin people at a large log-loss cost. With the calibrated primary the gain holds (+3.1 for the core
   profile, +3.6 for the full one, which is level with the state on log loss). One lead, seen twice. Shadowed since
   `cfg.default.v9` (`decision:typesafe/jev-1.13@jev-derived.v1`, ADR-0065) and read by that ADR's rule on new
   people; it needs its own calibration before it can serve.
8. **The reproduction check needs an evidence hash (built).** State hashes cannot match on a scrubbed export. Every
   prediction now stores `evidenceHash`, the hash of its state's evidence alone, which scrubbing does not touch, and
   the report's reproduction checks compare it for the `full` arm. Rows written before it carry none and are left
   out of that check; `stateHash` stays as it is.
9. **Individuation was unreadable on served data** (6 shared anchors). E7's shared items give across-person
   correlation and dispersion on every person, and the Twin run shows dispersion is where state policies differ
   (0.201 for the served state at k = 30 and 0.127–0.141 for 12-answer cards, but 0.231 for 8 answers retrieved by
   embeddings for the question).
10. **Lift over context is not learning the person.** On 120 Twin people the other respondents' answers to an item
    (the leave-one-out item mean) predict it as well as Jev with 30 answers (−0.005 [−0.025, +0.015]), and better than
    any context-only prior. DeepSeek with 30 answers passes the item mean (−0.030), and either model pooled with it
    beats both. So `full` against `context` measures some of what the population already knows; residual rows
    (`evaluate --from stored`, RESEARCH §1.2) measure the rest, and E7's shared probes give them on served people.

## References

- Toubia, Gui, Peng et al. (2025). Twin-2K-500: a dataset for building digital twins of over 2,000 people based on
  their answers to over 500 questions. arXiv:2505.17479; Marketing Science.
- Peng, Gui, Toubia et al. (2025). A mega-study of digital twins reveals strengths, weaknesses and opportunities for
  further improvement. arXiv:2509.19088.
- Park, Zou, Shaw et al. (2024). Generative agent simulations of 1,000 people. arXiv:2411.10109.
