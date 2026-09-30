# Question selection v2: value of information

Design note for the adaptive loop in PLAN §9.4–9.5 (ADR-0026). It replaces "ask what the predictor is unsure about"
with "ask what would most improve the mimic's decisions per question asked", and it makes the loop learn twice:
within a person as their answers arrive, and across people as more of them use it, without either loop being able
to make the other worse.

## 1. Goal

Predict a person's decisions across many domains as accurately as they predict themselves, with as few questions as
possible. Every served question therefore has to buy something: less uncertainty about the person where it matters,
a resolved contradiction, a domain we are still bad at, or a cheaper answer for the same information. The selector
scores each pooled candidate on those terms and picks the best one; the generator writes candidates that make good
buys possible.

## 2. What the research says, and what we take from it

| Finding | Source | What it changes here |
| --- | --- | --- |
| Adaptive tests pick the item with the most *information at the current estimate*, then balance content and cap exposure; posterior-weighted KL information beats plain Fisher information early in a test. | Components of the item selection algorithm in CAT (Han 2018, [PMC5968224](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5968224/)); Barrada et al. 2009 | A candidate's value is its information *given what we already believe*. Content balancing and exposure control are explicit terms, not side effects. Scenarios are pitched at the person's current lean, where an item is most informative. |
| Expected information gain (EIG) is the ideal-observer criterion for asking questions. People recognise high-EIG questions when shown them but rarely write them. | Rothe, Lake & Gureckis 2018, [Do people ask good questions?](https://link.springer.com/article/10.1007/s42113-018-0005-5) | Keep "generate many, select by an information criterion". The generator is steered by the belief state so the pool contains high-value questions to choose from. |
| Uncertainty sampling over-selects noisy items. BALD separates model disagreement (epistemic) from irreducible noise (aleatoric), but noisy items still attract it through large model updates. | Houlsby et al. 2011; [Batch active learning with noisy oracle](https://openreview.net/pdf?id=SJxIkkSKwB) | Disagreement between persona hypotheses is the information term when hypotheses exist; entropy is only the fallback. Reliability signals (§8) and exposure caps stop noise from monopolising the session. |
| Digital twins built from 2-hour interviews replicate GSS answers at 0.85 normalised accuracy, vs 0.74 for demographics-only twins; economic-game predictions do not improve with the interview. | Park et al. 2024, [Generative Agent Simulations of 1,000 People](https://arxiv.org/pdf/2411.10109) | Lift over the context-only baseline is the number that matters (already PLAN §2). Strategic and monetary decisions need their own probes; narrative evidence does not transfer to them. |
| Across 19 pre-registered studies, twins with rich individual data capture *relative* differences between people but are not significantly better than demographic personas at reproducing an individual's exact answers; twin responses are compressed toward stereotypes. | Peng, Toubia et al. 2025, [A mega-study of digital twins](https://arxiv.org/html/2509.19088v3); Toubia et al. 2025, Twin-2K-500 | The most valuable questions are the ones whose answer the stereotype gets wrong. Cross-person item statistics track exactly that: where the context-only baseline fails. |
| Response time falls with strength of preference (drift-diffusion); RTs rank people even when they all choose the same option and predict whether they will repeat or reverse the choice. Faster answers reflect more accessible attitudes that predict behaviour better (80% vs 44% of voting variance). | Konovalov & Krajbich 2019, [Revealed strength of preference](https://www.cambridge.org/core/journals/judgment-and-decision-making/article/revealed-strength-of-preference-inference-from-response-times/99BC30BD8728222C1B091CF07E2B682A); Fazio & Williams 1986; Bassili 1995 | Answer latency is a signal, not noise. It marks decisive vs torn answers in the state (`latencyHints`), it flags facets where the person is near indifference (conflict), and it discounts speeding answers. |
| Personality traits predict single acts at about r = 0.3 but aggregated behaviour at 0.6 or more; attitudes and past behaviour predict best when they match the target behaviour's action, context and time (principle of compatibility). | Mischel 1968; Epstein 1983; [Ajzen & Fishbein 1977](https://people.umass.edu/aizen/pubs/a-b.pdf); Ouellette & Wood 1998 | Facets generalise, but decisions in a domain are best predicted by decisions in that domain. Coverage is over facet groups *and* domains, and the running prediction error per domain steers both selection and generation. |
| Satisficing rises with questionnaire length, task difficulty and waning motivation; speeding and straightlining are its signatures. | Krosnick 1991; [Krosnick & Presser 2010](https://web.stanford.edu/dept/communication/faculty/krosnick/docs/2010/2010%20Handbook%20of%20Survey%20Research.pdf); Greszki, Meyer & Schoen 2014 | A burden term prefers short prompts and interleaved types and domains, and grows with session length. Speeding answers count for less. |
| Population priors with shrinkage recover individual estimates from designs too small to fit alone; the pooling weight falls as the person's own data grows. Persona dictionaries give closed-form posteriors and finite-mixture predictions for adaptive elicitation. | Lenk et al. 1996 (hierarchical Bayes conjoint); Wang, Wu & Zeevi 2026, [Adaptive Querying with AI Persona Priors](https://arxiv.org/abs/2605.00696); CAPE 2026 | Cross-person item statistics enter as a shrunk prior with a bounded weight. Persona hypotheses carry posterior weights updated from the person's answers, so exploration follows the readings their answers have not refuted. |

## 3. The belief state: known, unknown, conflicted, weak

`buildBelief()` (`packages/core/src/belief.ts`) is a pure, deterministic function of one person's data. Everything
below is in [0, 1].

Per facet *f*:

- **uncertainty(f)** — `½·H(trait dist)/log 5 + ½·(1 − Jev confidence)` from the latest trait read; 1 with no read.
- **conflict(f)** — the largest of: the gap between the Jev read and the psychometric read of the same facet; the share
  of insights citing *f* that were superseded by contradiction; repeat-probe disagreement on items touching *f*;
  plus half the share of *torn* answers on *f* (latency above twice the person's own median: near indifference).
- **weakness(f)** — the mimic's recent prediction error on questions touching *f*: `1 − item_acc` of the sealed
  primary over the last 12 such questions, shrunk toward the person's overall error with prior weight 2.
- **coverage(f)** — `min(1, n_f / 3)` as before; **exposure(f)** — share of the person's adaptive questions touching *f*.
- **need(f)** — the weighted sum the generator targets: `0.35·uncertainty + 0.25·conflict + 0.25·weakness + 0.15·(1 − coverage)`.

Per domain: share of adaptive questions vs the configured `domainMix`, and the same shrunk weakness.

Per person: median answer latency, speeding rate (answers faster than 30% of the median and under 2 s), and a
straightlining flag over the last six scale answers. Speeding answers get reliability 0.5 in every belief quantity.

## 4. The selection objective (`selector.type = 'voi'`)

For a pooled candidate *q* with primary prediction *p_q*:

```
score(q) = info(q)
         + λ · gap(q)                          content balancing: facet gaps and domain shortfall
         + β · conflict(q) + γ · weakness(q)   the person's own contradictions and the mimic's errors
         + π · (pop(q) − ½)                    cross-person item informativeness, shrunk (§7)
         − μ · redundancy(q)                   max similarity to anything asked
         − ν · burden(q)                       prompt length × session fatigue, plus type and domain streaks
```

- `info(q)` is the posterior-weighted BALD mutual information between the answer and the persona hypotheses when at
  least two hypotheses exist: `H(Σ_k w_k p_k) − Σ_k w_k H(p_k)`, normalised by `log|options|`. Without hypotheses it
  is the normalised entropy of *p_q*. MI rewards questions on which plausible readings of the person disagree and
  ignores questions that are merely noisy.
- Exposure control: a candidate whose facets already take more than `exposureCap` (35%) of the adaptive questions is
  excluded, unless every candidate is.
- The chosen question's primary prediction is its sealed prediction, exactly as with `entropy` (PLAN §9.5). The
  per-hypothesis predictions of the chosen question are stored as `role = hypothesis` rows (not scored), which is
  what the posterior in §6 reads.
- Every component of the winning score is stored on the question (`questions.selection_json`) so the choice can be
  audited offline.

Defaults in `cfg.default.v4`: λ 0.3, β 0.25, γ 0.25, π 0.15, μ 0.5, ν 0.2, K = 4, exposure cap 0.35.

## 5. Generation: belief-driven targets and adaptive difficulty (`gen.v2`)

`pool.refill` targets the five facets with the highest **need** (§3) instead of the five lowest counts, tags each with
why it is targeted (unexplored, uncertain, conflicted or weak), and tells the generator the person's current reading
on it (the trait label, e.g. "leans cautious", with its certainty). The prompt then asks for scenarios pitched at that
reading: trade-offs that would split people who already lean that way. This is the CAT rule that an item is most
informative where its difficulty matches the current estimate; for the trait "leans cautious", "$500 for sure vs a coin
flip for $1,100" is already answered, "$500 for sure vs a 30% chance of $2,000" is not.

The domain quota is tilted toward domains where the mimic is weakest (`mix_d · (½ + weakness_d)`, renormalised), and
facets over the exposure cap are listed as ones to avoid.

Population statistics never enter the generator prompt (PLAN §3.8).

## 6. Persona posterior: the loop within a person

Persona hypotheses (`hyp.v1`, refreshed after each reflection) are K readings of the person that differ on the facets
with the least certainty. Each selection predicts the whole pool under each hypothesis. Storing the chosen question's
per-hypothesis predictions makes the hypotheses a proper finite mixture: when the answer arrives, hypothesis *k*'s
weight becomes

```
w_k ∝ Π_t p_k(a_t)   over questions t answered since this hypothesis set was written
```

(a uniform prior, likelihoods floored at 1e-4). The next selection uses those weights in `info(q)`, so a reading the
person has already refuted stops steering exploration. The weights are recomputed from stored rows on every serve; no
mutable state is kept. This is the closed-form persona-membership posterior of Wang, Wu & Zeevi (2026), with
hypotheses written per person from their own evidence rather than a fixed dictionary, which keeps PLAN §3.8 intact.

## 7. Cross-person learning: item statistics (the loop across people)

A cron job (`stats.refresh`, hourly) aggregates the scored questions of research-consented, **dev-split** mimics into
`item_stats`:

- **items** with a stable `item_key` (anchors, reserve bank): the number of people, the normalised entropy of their
  answers (discrimination: an item everyone answers the same way carries no information about individuals), the
  context-only baseline's error, the primary's error and log loss, lift, and mean latency;
- **archetypes** `facet | domain | type`: the same, minus answer entropy, because generated prompts are unique per person.

`pop(q)` is an item's `½·answer entropy + ½·baseline error` (or, for generated questions, the mean over its facets'
archetypes of `½·surprise + ½·baseline error`), shrunk toward ½ with a prior weight of 20 answers, and null (no effect)
below 5 people. It directly targets the mega-study's finding: the questions worth asking are the ones the demographic
stereotype gets wrong.

Rules: aggregate-only rows with no free text and no per-person data; consented dev-split mimics only, so the test
split stays clean; used for ranking pooled candidates only, never in a prompt or a state; weight bounded by π.

## 8. Reliability signals from response time

- `stateBuilder.latencyHints` (on in v4) annotates each state evidence item with `pace: 'quick'` (under half the
  person's median latency over the sealed evidence) or `pace: 'slow'` (over twice). The predictor sees which answers
  were decisive and which were torn. The builder is versioned (`full.v2`) and stays deterministic from exported data.
- Torn answers raise a facet's conflict; speeding answers count half in the belief state.
- Repeat probes stay uniformly random (PLAN §9.5). Biasing them toward torn items would lower measured self-consistency
  and inflate fidelity.

## 9. Why it cannot get worse with more use

Within a person:

- Every term is bounded and the informative terms decay on their own: coverage saturates, uncertainty and conflict
  fall as answers arrive, and the exposure cap stops any facet from monopolising the session even when its answers
  stay noisy (the noisy-oracle trap of uncertainty sampling).
- Weakness is prequential: it reacts to the mimic's real errors on this person, not to the model's opinion of itself.
- The persona posterior only reweights hypotheses that were each written to be consistent with all evidence; with
  one hypothesis or none, `info` falls back to entropy.
- Burden grows with session length, so late questions get shorter and more varied rather than harder.
- Sealing, the evidence budget and the citation guard are unchanged (PLAN §3).

Across people:

- Item statistics are a prior with a bounded weight (π) and Bayesian shrinkage toward neutral; a handful of people
  cannot move them, and no population value can override a person's own uncertainty, conflict or weakness terms.
- They are computed on the dev split only and reported as a separate ablation in `pnpm eval -- select`, so a
  regression from the population term is visible before it is trusted.
- The dispersion ratio and across-person correlation (PLAN §12.3) remain the stereotyping alarms.

## 10. Evaluation

- `pnpm eval -- select --selector entropy,voi --budget 5,10,20` runs each selector on the same export and reports
  accuracy on the held-back pool per budget, side by side (still the biased, pool-restricted simulation of ADR-0018;
  iteration only). `--no-population` runs `voi` without item statistics.
- Online: E3 arms `entropy` vs `voi` on questions-to-sustained-fidelity and fidelity at 20 (PLAN §12.7).
- `latencyHints` is a state ablation for replay (E2).

## 11. What changes in code

- `packages/core/src/belief.ts` — belief state; `selectors.ts` — `VoiSelector`, hypothesis posterior, burden;
  `population.ts` — item statistics and the shrunk prior; `prompts.ts` — `gen.v2`; `state-builder.ts` — latency hints.
- `PipelineConfig`: `selector.type = 'voi'` with its weights; `stateBuilder.latencyHints`; `generator.promptVersion = 'gen.v2'`.
- Schema (migration 0003): `questions.selection_json`, `predictions.hypothesis`, table `item_stats`.
- Jobs: `stats.refresh` (cron); `hypotheses.refresh` also runs for `voi`.
- Default config `cfg.default.v4`. Older mimics keep their config, as always.

## 12. Deliberately not done

- A one-step lookahead EIG on the pool (predict the rest of the pool under each possible answer) is the exact
  criterion but costs |pool| × |options| Jev calls per selection. The hypothesis MI approximates it at K calls.
- A shared bank of generated questions that proved informative across people. Generated prompts can embed a person's
  facts, so reuse needs a leakage check first.
- Item statistics from Twin-2K-500 as a cold-start prior for anchors and reserve items (the importer already maps
  the items).
