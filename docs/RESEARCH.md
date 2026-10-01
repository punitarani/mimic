# Research agenda

Where Mimic goes next, and how each direction gets decided. Written 2026-10-01 from a literature pass (about 200
sources, 2023–2026; the ones that changed a design are cited inline) and from what the codebase measures today. Every
direction ends in an experiment the eval CLI can run, because a direction that cannot be scored on sealed answers is
a story, not research.

Two facts frame all of it:

- **Twins reproduce item means, not people.** Across 19 pre-registered studies, full-persona twins sat at 0.748
  individual accuracy against 0.746 for demographics alone and 0.734 for an empty persona (Peng, Toubia et al. 2025,
  arXiv 2509.19088). With item means removed, LLM twins explained 3% of respondent-specific variance where test-retest
  explains 54% (arXiv 2608.29455). So every result here is reported as **lift over the context-only baseline** and,
  where the data allow, on **residuals from item means** (direction 1.2). A gain that vanishes on residuals is the
  stereotype getting better.
- **In-domain evidence beats everything.** One training task similar to the held-out task moved accuracy from .743
  to .787 in a pre-registered study of 317 people, more than the whole interview did (arXiv 2609.29143); Park et al.
  (2026 revision of arXiv 2411.10109) find gains asymptote once a domain is covered; the person × item interaction is
  8.9× the stable person effect (arXiv 2608.29455). Mimic's typed, situation-first questions (ADR-0042) are the
  right primitive; what remains is choosing them for the decisions the mimic will have to make.

Status words used below: **built** (in the repo, tested offline, awaiting real people), **designed** (spec in this
file, no code), **open** (a question with no settled design).

---

## 1. Fewer questions, better alignment

### What Mimic has

Value-of-information selection over LLM-generated candidates (docs/SELECTION.md): BALD over K persona hypotheses with
a prequential posterior, conflict and weakness terms, cross-person item statistics, category balance, coverage
deadlines, a trust ramp. This is the design the 2025–2026 literature converges on (BED-LLM, arXiv 2508.21184: sampled
hypotheses with an explicit likelihood beat in-context updating by 37 points on 20 Questions; persona priors with a
closed-form posterior beat CAT at every budget, arXiv 2605.00696). Two of its findings are not yet in Mimic.

### 1.1 Offline-optimised opening block — designed

Greedy adaptive selection wins only early; a fixed, non-adaptive design overtakes it after 10–15 items
(arXiv 2605.00696), and content-only short forms built from embeddings reach *r* = .95–.98 with the full scale with no
response data (Jung & Seo 2025). Mimic's anchors are ten hand-picked items. Replace them with a block chosen on the
dev split for a predict-the-rest objective: pick the 10 stable items (anchors and reserve) whose answers best predict
the remaining answers across people, under embedding-cluster coverage. **Experiment:** `pnpm eval -- select` with a
`fixed` opening block against `voi` on questions-to-sustained-fidelity; then an arm.

### 1.2 Residual fidelity — designed

Report lift over an item-mean predictor beside lift over the context baseline, and select by expected residual-variance
reduction. `item_stats` already holds per-item answer entropy and baseline error; a population-mode predictor is a
derived row per stable item. **Experiment:** add `residual` rows to `evaluate --from stored` and to `/lab`; selection
weight `pop(q)` becomes primary once the residual metric exists.

### 1.3 Decision coverage, not trait coverage — open

Coverage today is over facets and categories. The strongest effects in the literature are in-domain probes. A mimic
built for an assistant that books travel and answers email needs travel and email decisions, not a fourth
conscientiousness item. **Design:** a *target decision distribution* per mimic (from the person's stated use, or from
the observation ledger, §3), and an EIG weighted by transfer to it. The honest version measures fidelity on those
decisions, which the ledger will supply (§3.2). Expect facet coverage to lose when the target is narrow.

### 1.4 Generate-to-split — designed

Nothing in the ask-the-next-question literature generates a question *conditioned on which hypotheses disagree*
(BED-LLM proposes blind, then scores). Mimic has the hypotheses. Feed the generator the two highest-weight hypotheses
that disagree most on a facet and ask for a scenario they would answer differently; score with BALD as now. Pitfall:
hypotheses are LLM readings and may disagree about the stereotype; count lift only on residuals and repeat probes.
**Experiment:** a `gen.v4` arm, judged on questions-to-sustained-fidelity and on the dispersion ratio.

### 1.5 Latency as information and cost — designed

Response time tracks strength of preference (Konovalov & Krajbich 2019) and Centaur explains response times from
response entropy at R² = 0.87 (Binz et al., Nature 2025); no twin paper uses it. Mimic logs every latency and already
marks torn answers in the state. Next: information *per second* in the selector's burden term, latency in the
hypothesis likelihood (a slow answer is weak evidence for whichever hypothesis it favours), and a one-line "why"
asked only after a slow answer (unmeasured anywhere). **Experiment:** replay E2 with `latencyHints` off/on is the
first half; the conditional "why" needs an arm.

### 1.6 Stop when it stops paying — designed

A value-of-information stopping rule (ask only while the expected fidelity gain exceeds the person's cost of
answering; arXiv 2601.06407) in place of "about 30". The belief state has the inputs. **Experiment:** simulate on
exports; report questions saved at equal fidelity.

### 1.7 Calibrate before planning — designed

A planner on an uncalibrated simulator loses ~15% to random selection on hard items (arXiv 2504.04204). The hypothesis
posterior uses raw likelihoods; fit a per-person temperature on them prequentially (as ADR-0048 did for the primary),
or use conformal sets (arXiv 2507.03279) from stored predictions, which cost nothing.

---

## 2. Harness and prompt engineering

### What Mimic has

Third-person prediction for Jev and the LLMs (confirmed by arXiv 2607.24782: forecasting beats role-play on three of
four hosted models), reasoning kept low (chain-of-thought lowers twin accuracy and calibration: Twin-2K-500 71.7% →
70.4% with reasoning; KalshiBench; SimBench finds fidelity scales with model size, not inference compute), a calibrated
primary, GEPA-style prompt optimisation (docs/OPTIMIZATION.md), and retrieval of similar answers when evidence
outgrows the budget.

### 2.1 Pools of what is already stored — built (ADR-0058)

`pnpm eval -- ensemble`: equal-weight pools, Hedge/BMA weights learned per person from earlier questions only, a
hindsight oracle as a bound, all paired against the primary. Zero new calls. **Decision rule:** a pool ships as a
registered variant and shadow if its paired log-loss interval is below zero on the test split with accuracy not lower.

### 2.2 Evidence-view ensemble on Jev — built (ADR-0058)

`replay --views raw,structured,summary`: the same predictor on several views of the same sealed evidence, pooled.
Agents on identical evidence herd; information asymmetry is what gives pooling its 12–18% Brier gains
(arXiv 2607.01661). On Jev the extra views cost input-priced calls only.

### 2.3 One-vs-rest criteria with structure — designed

TypeSafe's own guidance: criteria as `{what, not_for, examples}` objects, dotted references into the state
("judge from `evidence` and `traits`"), only the context the questions need. Mimic already emulates one-vs-rest for
span-01 (ADR-0051). **Experiment:** `jev-predict.v3` with structured criteria and one `noul` per option, against the
`choice` primitive, on sealed instances via `evaluate`; it also cancels option-position effects (arXiv 2506.14092).

### 2.4 Per-person empirical-Bayes temperature — designed

ADR-0048 fitted one temperature. People differ in how predictable they are; the many-small-problems regime wants a
per-person *T* shrunk toward the global one (Prediction-Powered Adaptive Shrinkage, arXiv 2502.14166). Derived from
stored rows at zero cost; `evaluate --from stored` is the place.

### 2.5 Audit the shadows' probabilities — designed

Verbalised probabilities are sparse (one model emits eight distinct values, half of them "95%"; arXiv 2608.04899), so
ECE differences between shadows can be binning artefacts. Report the number of distinct values per shadow in `/lab`
and judge shadows on log loss; for scale items try semantic similarity rating (a one-sentence answer mapped to the
five labels by embedding, arXiv 2510.08338).

### 2.6 Order for the cache — designed

Mimic renders traits before evidence, so every new answer invalidates the cached prefix after ~600 identity tokens,
below OpenAI's 1,024-token minimum. Render the evidence log as an append-only prefix and the derived sections last
("dynamic content last", arXiv 2601.06007). A state-rendering variant, measured on cost and latency per shadow call.

---

## 3. Transfer and self-evolving memory

### What Mimic has

`mimic.json` (schema `mimic/1`), `SOUL.md` in `full` and `core` profiles (ADR-0039), and now provenance per answer,
the observation ledger (ADR-0060) and the transfer eval (ADR-0057).

### 3.1 Measure the loss — built (ADR-0057)

`pnpm eval -- transfer` renders each export view from sealed evidence and scores a reader that knows nothing about
Mimic on later answers, against the full state, at each view's size. **Hypotheses:** the loss is small because the
person-specific signal is small (2608.29455); `soul-core` beats `mimic-json` for LLM readers (text persona 71.7% vs
JSON 70.5% on Twin-2K-500); the card at ~600 tokens is within two points of the full state. **Matrix to run:** views ×
readers (one cheap LLM, Jev) × checkpoints 10/20/30, with `--draft`, on the consented cohort. Then the host
conditions nobody evaluates: the file in the system position vs the user position, truncated at 20,000 / 4,000 /
1,375 characters, after 100 filler turns, after compaction. A re-anchor snippet (~110 tokens restores register for 20+
turns, arXiv 2605.24279) is the mitigation to test.

### 3.2 Evidence-only writes — built (ADR-0060)

Any agent appends typed observations; Mimic validates and re-derives. This follows the strongest result in the
memory literature: appending raw episodes beats lesson-style consolidators, whose utility rises then falls
(arXiv 2605.12978), and authority labels cut unauthorised actions from 50% to 0% (arXiv 2608.01679). **Next:**
API tokens for agents, an MCP server (`append_observation`, `get_view`), and `authority: observed` answers weighted
below `stated` ones in the state (today they enter alike; the first measurement is whether observed answers predict
session answers as well as taught ones do, which the ledger makes free to compute).

### 3.3 Views sized to hosts — designed

Every host truncates: OpenClaw at 20,000 characters per bootstrap file and 4,000 for USER.md, Hermes at 1,375 for
USER.md and 2,200 for MEMORY.md, Letta's `human` block at 2,000, claude.ai re-extracts imports into one-line entries.
A view per host from one source: `SOUL.core.md` under 20,000 characters, a USER.md of imperative directives
(Always/Never/Prefer, each dated) under 4,000, a Hermes USER.md under 1,375 holding boundaries and the five strongest
tendencies, a Letta `.af` with answers as messages, a one-claim-per-line export for claude.ai. Front matter lists the
hashes of the views so a reader can prove which rendering it holds. The transfer eval scores each at its real cap.

### 3.4 Content-addressed evidence — designed

Portable Agent Memory (arXiv 2605.11032) content-addresses memories and signs the root. Mimic's answers already have
stable seqs and hashes; add a per-answer id (hash of question, options, answer, seq), a Merkle root over the record in
`mimic.json`, and the root in every view's front matter. Removal is a tombstone every re-derivation honours (which the
undo and fact removal already do). Cheap, and it makes "which version of me did you read?" answerable.

---

## 4. From a footprint to a mimic

### What Mimic has

Identity enrichment (sourced facts for the baseline) and now the footprint pipeline (ADR-0061): parsers for the
person's own exports, hygiene, questions the documents imply, and the footprint scored as a predictor.

### 4.1 Footprint accuracy per source — built (ADR-0061)

The number no paper reports: how often a person's record was right about them, per source, measured by the person's
own answer to a question the record implied. **Hypotheses:** GitHub and LinkedIn imply work decisions above the
baseline and nothing else; posts imply voice, not decisions (style imitation works for news and email, fails for blogs
and forums, arXiv 2509.14543; frontier models reach 37–55% on implicit preferences, arXiv 2512.06688); recency matters
(ρ = .50 with recent posts vs .29 without, Marengo et al. 2025). **Run:** `pnpm eval -- footprint --propose` on
consenting people, then read `footprint:v1` in `/lab` and `evaluate --from stored`.

### 4.2 Footprint to choose, not to answer — designed

Feed implied answers into the belief state with inflated variance, and ask first where the footprint and the baseline
disagree: the questions a record cannot settle. A persona-mixture prior from a synthetic bank (Nemotron-Personas,
arXiv 2605.00696) ranks items only, like `item_stats`, so invariant 8 holds.

### 4.3 A verification budget — designed

Spend about five of thirty questions verifying the highest-impact implied answers per source; fit per-person,
per-source trust from those; let a trusted source's remaining implied answers enter the state as evidence marked
`observed`. Report questions saved at equal fidelity. This is the only path by which a footprint ever becomes
evidence, and it is gated by the person's own answers.

### 4.4 Retrieval vs generalisation — designed

Tag served questions by whether a near-verbatim document exists; report fidelity on both. Park et al. show accuracy
falls when near-verbatim items are dropped: part of every footprint gain is memory, not a model of the person.

### 4.5 What stays out

Scraping (LinkedIn v. Proxycurl ended it; X's API is pay-per-read), third parties' words (DMs, email threads, Slack
exports), and any inference into politics, religion, sexuality or health (CJEU C-252/21 treats inferred
special-category data as special-category data). Slack and email need a different design: the person's *sent* messages
only, parsed locally, with every quoted line removed; the parsers' `ownWordsOnly` rule is the start.

---

## 5. Populations for simulations

### What Mimic has

`pnpm eval -- population` (ADR-0059): copula over facet means, exemplar-drawn answers, realism metrics, Concordia and
Smallville renderings, a questionnaire for in-simulation scoring.

### 5.1 Does the population keep the cohort's structure? — built, unmeasured

Run on the consented cohort once it passes five people per facet: dispersion ratio near 1, caricature under 0.3,
re-identification well below 1 (a copy) and above 0 (a stereotype), sensitive leakage no higher than the real cohort's.
**Hypothesis:** the exemplar step is what keeps dispersion; a chat model filling the same facet vectors collapses it
(arXiv 2607.25292, 2609.07305).

### 5.2 Rectify, don't trust — designed

Synthesis alone biases estimates by 24–86%; prediction-powered inference with a small human sample brings bias under
5%, and 60–80% of the human budget should go to rectification (Krsteski et al., ACL 2026, arXiv 2510.11408). The real
mimics are the calibration set. Ship a PPI/AIPW recipe with every `mimic-population/1` file: an aggregate estimated on
the synthetic agents is corrected against the same estimate on the real anchors.

### 5.3 Transplant evidence, not backstory — designed

The next renderings write Concordia `player_specific_memories` from real answers (first person, dated episodes built
from the sampled items) so the formative-memories initialiser invents nothing, and Sotopia's `AgentProfile` from the
facet vector (`big_five`, `schwartz_personal_values`, `decision_making_style`). Then the in-simulation check: the
questionnaire before and after *k* steps of a Concordia scenario, per facet, as a prequential fidelity for agents.
Survey-accurate twins hold at the start of a game and diverge by the end (SILICA, arXiv 2608.28182); a refreshed
memory anchor is the known mitigation (arXiv 2607.10539).

### 5.4 Rake to the world — designed

A cohort is who signed up. Rake the sampled population to external marginals (Census, WVS, Twin-2K-500 item means)
and report the effective sample size as the headline realism number, so a population built from thirty engineers in
one city cannot pass for a country.

---

## 6. Representing and compressing a twin

### What Mimic has

A budgeted state builder with four ablations, latency hints, retrieval, and now evidence policies and the card
(ADR-0056).

### 6.1 What should a state keep? — built (ADR-0056)

`replay --state card --evidence surprise|novelty|recent|similar --max-evidence N --budget T` on the same export, at
equal tokens. **Hypothesis:** `surprise` beats `recent` and `similar` at 8–12 answers because it keeps the residual
from the stereotype, and `novelty` beats `surprise` late in a session because it removes redundancy among the person's
own answers. The guard is the dispersion ratio: a compression that scores well by predicting the population mode will
show it there. Report "nats gained per 1,000 state tokens", which no paper frames.

### 6.2 Structure, searched — designed

A hand schema (background, decision procedure, evaluation) beats the raw transcript by 1.9 points on Twin-2K-500 and
ties on the mega-study; task-discovered structures add another 2 points (arXiv 2608.20344). SOUL.md's sections are a
hand schema. Let GEPA (docs/OPTIMIZATION.md) search the *sections* of the rendered state, not only the wording, with
the transfer eval as the metric.

### 6.3 Surprise hints and conditional "why" — designed

Mark answers in the state text that the baseline mispredicted (as `pace` marks torn ones) so the predictor knows
which answers individuate; attach the "why" only to retrieved items. Both are state-rendering variants for replay.

### 6.4 Per-person parameters — open

Shared basis plus a per-user low-rank residual (+4.6% over OPPU on OpinionQA/Twin-2K, arXiv 2609.04738), latent
personal memory slots (beats LoRA by 8.8% with 64× less KV cache, arXiv 2606.20911), and persona vectors that stay
stable over long contexts. None is reachable through OpenRouter, and Centaur-style fine-tuning gains 0.14–0.30 nats
on choices. Revisit when a self-hosted model is on the table; the sealed instance set and the transfer eval are the
benchmark either way.

---

## 7. Directions the review opened

- **Honest ceilings per domain.** Report self-consistency per category, not one number: the ceiling on money
  decisions is not the ceiling on social ones.
- **Amortised selection.** Distil the VOI selector into a small policy trained on replayed sessions (ASIG,
  arXiv 2607.03426: 25–36× cheaper than full BED), with Pep's answer-sensitivity diagnostic (does the next question
  change when the answer changes? 39–62% for a real model, 0–28% for a collapsed one, arXiv 2602.15012).
- **Agents as interviewers.** Adaptive follow-up questions beat static bios on decision accuracy (45.5% vs 39.3%,
  arXiv 2605.29458). The observation ledger lets a person's own agent ask Mimic's next question in its own channel
  and return the answer; the session becomes continuous and in-domain by construction.
- **Twin identifiability as a privacy metric.** The re-identification rate in the population builder doubles as a
  disclosure risk for any aggregate export; keep it below the human test-retest identifiability of the cohort.
- **The "why" as data.** No paper isolates the marginal value of a free-text reason; Mimic stores one on every answer
  that has it. A replay with reasons stripped from the state is one flag away.

---

## 8. How results are read

- Real people only; scripted and simulated sessions prove machinery (`populationOf`, PLAN §14 R10).
- Paired comparisons with bootstrap intervals on sealed instances (ADR-0048); test split only for final numbers.
- Lift over the context baseline, and residual lift where item means exist; dispersion ratio and across-person
  correlation as the stereotype alarms (PLAN §12.3).
- A change ships as a registered variant and a shadow before it touches the primary (ADR-0024, ADR-0041).
- Nothing crosses people except aggregates with a minimum group size (PLAN §3.8, `item_stats`, ADR-0059).
- Imported people (Twin-2K-500) rank states, policies and readers for the same predictor on the same questions
  (`docs/reports/twin-benchmark.md`); they never stand in for a result about a Mimic user.

## 9. Order of work

| Step | Needs | Decides |
| --- | --- | --- |
| E7 probe set (`docs/PROBE.md`): built as `cfg.e7.probes` and the `e7` preset; start it in `/lab` | people to read it | §10.1, E3b's yardstick |
| Evidence hash for the reproduction check; temperature by evidence count | nothing | §10.4, §10.5 |
| Retrieval by meaning and the LLM-written state for Jev, as shadows on served questions | nothing | §10.2, §10.3 |
| Run `transfer`, `ensemble`, `replay --evidence` on the consented cohort | people, ~$1 | §3.1, §2.1, §6.1 |
| Residual metric in `evaluate` and `/lab` | nothing | §1.2 |
| `jev-predict.v3` structured criteria; per-person temperature | nothing | §2.3, §2.4 |
| Footprint proposals with consenting people | people, ~$0.05 each | §4.1 |
| Host-sized views and the host-condition matrix | §3.1 | §3.3 |
| Opening block, generate-to-split, VoI stopping, latency terms | exports | §1.1, §1.4, §1.5, §1.6 |
| Population on the cohort; rectification recipe; Concordia memories | five people per facet | §5 |
| Observation tokens, MCP server, observed-vs-stated weighting | §3.2 | §3.2 |

---

## 10. What E6 and the Twin benchmark changed

E6 (`docs/EVIDENCE.md`, verdict `questions`) and the Twin benchmark (`docs/reports/twin-benchmark.md`) were the first
measurements behind this agenda. They moved five things to the front of the queue and reframed the question every
section above asks.

### 10.1 Learning is a function of distance, and nothing measures it yet — E7

Twin's lift is transfer from demographics and personality scales to product choices (96% of the lift at k = 100 sits
in 61% of the items; no held-out domain appears in the first 100 answers). Served questions are the far end by
construction: selection asks what is least known. Neither dataset measures near transfer, and no dataset measures
all distances on one person, so "does the mimic learn from answers" has had no single answer. E7 (`docs/PROBE.md`)
asks everyone the same items at four distances (a repeat, the same template, the same facet, an uncovered facet) and
three shared items with public item means, predicted from the sealed state before they are shown. It gives the
residual lift of §1.2 and the dispersion alarm of §8 on every person, a per-person ceiling, and the yardstick E3b
needs. It is the first step of §9 now. Expect: near transfer at 10 answers, mid at 30, far not before compaction
(§10.3) works.

### 10.2 Retrieval by meaning, not words

Beyond the budget the state keeps the recent and the lexically similar. Party and ideology carry policy items and
materialism rows carry product items, and none of them share a word with the question they predict. Sorting Twin's
items by nearest-prompt word overlap orders them by domain, not by relatedness, so `relevant` (E6) and the `similar`
card (ADR-0056) are limited by their distance measure. **Build:** a question-conditioned retriever with embeddings
(the state builder already takes `queryEmbedding`; the export does not carry vectors, so replay needs them computed
once per export) and an LLM-chosen "which answers bear on this question" pass whose picks are logged as a view.
**Experiment:** both as `relevant`-style views on E7's probes and on Twin's policy and product items, judged by
lift per domain against the recency state. Pitfall: an LLM retriever that reads the question can smuggle a guess;
log its picks and score the view, never its text.

### 10.3 Compaction that keeps what the window loses

The served state at 100 answers is the 18 most recent, and the answers that predicted policy support left with the
window. Traits and insights exist to hold what the answers said after the answers are gone, and two findings say Jev
reads them well: `derived` gave +4.8 points on served questions (E6, exploratory) and the core SOUL.md gave the Jev
reader +3.7 over the state text on 60 Twin people, both with no log-loss gain or a loss. **Build:** the reflector
writes the primary's state (an LLM-written state for Jev), calibrated on its own stored predictions, as a shadow
predictor (`decision:typesafe/jev-1.13@jev-predict.v3` with a `stateView: derived+answers` harness). **Experiment:**
served shadow, then E7's probes, with residual lift and dispersion beside accuracy, since a summary can be a
stereotype written down. The `surprise` policy is the cheap version: it keeps the answers the stereotype got wrong
and preserved dispersion (0.197 against 0.127 for recency at k = 30) at the same accuracy.

### 10.4 Calibration by state size

One temperature holds at 30 answers (ECE 0.036) and not at 100 (0.111). A view that changes the state's size changes
its calibration, so every log-loss comparison between views mixes two effects. **Build:** T as a function of evidence
count (or tokens), fitted prequentially on stored predictions as ADR-0048 fitted the constant; report ECE by k on
every readout. Cheap and decisive; it goes before any view is judged on log loss again.

### 10.5 The yardsticks themselves

- **State-insensitive items.** On Twin's probability tasks the primary's distribution is the same for every view.
  Such items are ties in any view comparison and dilute every effect by their share (12% there). Count them, report
  them apart, and let E7 estimate their share on Mimic's questions.
- **An evidence hash beside the state hash.** The reproduction check cannot match state hashes on a scrubbed
  export. A hash over the answers alone (seqs, values, reasons) is scrub-invariant and would let the workflow check
  reproduction every run.
- **Power, stated.** Six people decide nothing under five points; a Twin-sized effect needs about 25 consented
  people at 55 questions each. Readouts say "unknown" until then, as EVIDENCE_RULE does.
- **Where the LLM shadows' lift came from.** DeepSeek's context-only prior beats every Jev view on served questions.
  A better prior is worth having (an LLM or pooled primary within the latency target, E6's `model` branch), but it
  is not learning, and a mimic that is only a better prior is a stereotype with a nicer voice. Residual lift and
  dispersion, not accuracy, are what separate the two.

### 10.6 What stands

The directions in §1–§6 stand, with their order changed: measurement (E7) first, then the state (retrieval and
compaction), then selection (E3b, the opening block, generate-to-split), since selection pays off only through a
predictor whose state carries what the answers said. The card (ADR-0056) is ready as the export for agents: level
with the served state at 30 answers, best dispersion among the compressed states, half the tokens. The footprint,
the ledger and the population builder are unaffected by any of this.

