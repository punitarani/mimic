# E9: which question to ask next

v1 · 2026-10-02 · Status: built; the design and `CURVES_RULE` were fixed before the first run. ADR-0071.

E9 measures how fast each question-selection policy lets Jev learn a person: the learning curve of Jev's accuracy on
a person's held-out decisions as a policy asks them more of their own recorded answers. It ranks selection
principles on real recorded answers, so the winner can go to real Mimic users as an arm (E7/E3b).

## 1. Why

Mimic's selector (`voi`, `docs/SELECTION.md`) has never been measured on real answers.
- `select` replays a policy over a person's served questions, but that pool was itself chosen online, so the replay
  is biased (ADR-0018). It also doesn't run on Twin.
- E3b compares selectors on real people, and needs about 64 per arm; there are 9.
- E6 and E8 ask Jev in survey order. A state that holds demographics and Big Five rows until about 100 answers
  learns slowly, and what is in the state decides what transfers (`docs/reports/twin-benchmark.md`). So *which*
  answers Mimic gets should matter as much as how many.

Twin-2K-500 gives every person the same full questionnaire, answered for real. A policy can choose from a person's
whole pool, and the answer it gets is the one the person actually gave: no simulated users, and no pool chosen by
another policy.

## 2. Questions

1. How much does the order of questions matter: survey order and random against the best policy?
2. Does asking what Jev is least sure of (production's info term without hypotheses) beat random?
3. Does a lookahead — Jev's expected information about the decisions to predict — beat both?
4. How much does knowing the population add: a persona posterior over other people's answers?
5. Where do the curves flatten, and how many questions does the best policy save at equal accuracy?

## 3. Data

The `wave_split` export of Twin-2K-500: 2,058 people, written to `data/twin-full.jsonl` by
`python3 packages/eval/scripts/twin-rows.py data/twin-full.jsonl` (it pages the datasets-server API, so it works where
Hugging Face's CDN is blocked).

- **People** are assigned once, by `unitHash('e9:people:' + pid)`:
  - **train** (half): their answers feed the population statistics two policies select with; never scored;
  - **dev** (three tenths): every iteration round;
  - **test** (a fifth): read once, for the confirmatory run (§7).
- **Pool:** every typed wave 1–3 answer: 420 per person (demographics 9, personality 199, cognitive tests 43,
  economic preferences 169), in survey order. Any pool item that matches a wave 4 question, by signature or by
  question ID, is dropped; on the real export the blocks are disjoint and the audit drops none.
- **Targets:** the wave 4 items (64 to 68 per person: 40 pricing decisions with person-specific products, the rest
  heuristics-and-biases tasks), split once by Qualtrics question with `unitHash('e9:rt:' + qid)`:
  - **R** (reference, about 30): a policy may read their *questions*, never their answers;
  - **T** (about 36): scored only.
- **Ceiling:** each person's wave 1–3 answers to the wave 4 questions (test–retest). The mean agreement on T is the
  person's own consistency; fidelity is accuracy divided by it, and parity is fidelity 1.

## 4. Policies

Each picks the next item from what is left of the pool. After each pick the person's recorded answer is revealed.

| Policy | Picks | Model calls |
| --- | --- | --- |
| `order` | Survey order (what E6 and E8 use) | none |
| `random` | Uniformly at random (the reference) | none |
| `stratified` | Round-robin over the four survey blocks, random within | none |
| `jev-entropy` | The highest normalised entropy of Jev's prediction among 60 random candidates (production's info term without hypotheses) | 3 a step |
| `pop-static` | A fixed questionnaire: greedy expected information about R, averaged over 40 probe train people | none |
| `pop-eig` | The highest expected information about R under a persona posterior over the train people | none |
| `jev-eig` | Jev's lookahead: the 6 highest-entropy candidates; for each answer Jev expects (q(a) ≥ 0.05), Jev predicts 20 R questions from the state with that answer; gain = Σ_r H(Σ_a q(a)·p_r^a) − Σ_a q(a)·H(p_r^a) | about 24 a step |
| `hybrid` | `pop-eig`'s 6 best, reranked by Jev's lookahead | about 22 a step |

- **Persona posterior** (`population.ts`): w_j ∝ Π E[a_j][v] over the train people j, with E a noisy channel (ε =
  0.15; a scale's emission spreads to neighbouring levels, σ = 0.6). The expected information of an item about each
  R question is the mutual information of their answers under the posterior mixture, in closed form.
- **Cross-person data** (ADR-0071): the population only orders the pool. It never enters a prompt or a state, as
  `item_stats` (ADR-0027) never does. This is the experiment flag invariant 8 asks for.
- **Planning temperature:** Jev's raw probabilities are overconfident (T ≈ 4.8 on Twin, E8), so selection reads them
  at T_sel = 4, Jev's served temperature, never a temperature fitted on the scored people.

## 5. Measurement

- **Checkpoints:** k = 0, 3, 6, 10, 15, 20, 25, 30. At each, Jev predicts every T target from a sealed state holding
  exactly the first k answers asked (`stateAfter`; invariant 1), with no trimming (budget 24,000 tokens). For the
  first k survey answers this is the state E6 and E8 sent.
- **Calibration:** each (policy, k) cell gets its own temperature, fitted leaving each person out
  (`looTemperatures`), so no policy is judged on raw probabilities and no person's answers choose their own scale.
- **AULC:** mean calibrated log loss over k = 3 … 30. Pairs are by person and target; intervals resample people
  (`pairedByPerson`, 2,000 resamples, 90%).
- **Also reported:** the curves; accuracy and fidelity at each k; questions a policy needs to reach `order`'s
  accuracy at 30 (interpolated, people bootstrap); results by target group (pricing, heuristics and biases); which
  blocks each policy asked and its most common opener; spend on selection and on scoring.
- **Request cache** (`decision-cache.ts`): every answered Jev request is kept on disk by its content hash. Policies
  that send the same request get the same answer (Jev isn't repeatable, `docs/reports/e8b-tuning.md`), and a rerun
  or resume costs nothing.

## 6. Rule (`CURVES_RULE`, `packages/eval/src/curves/analyze.ts`)

Fixed before the first run. Against `random`:
- **better:** at least 30 people, the AULC interval lies below 0, and accuracy at k = 30 is no more than 1 point
  below random's;
- **worse:** the AULC interval lies above 0;
- **level** otherwise; **insufficient** under 30 people.

## 7. Iterating without overfitting

- **Dev rounds.** Round 1 runs all eight policies on 150 dev people. Each later round tests one hypothesis (for
  example a shortlist size, the reference, the planning temperature, a fixed opening block, a stopping rule) on dev
  people, and a knob is chosen by leave-one-person-out over dev people, never on the people it is scored on.
- **Plateau.** Rounds stop when two in a row improve the best AULC by less than 0.003 nats, or by an interval that
  includes 0; at most six rounds and about $250.
- **Test.** The final set (the best two or three, with `order` and `random`) and the rule are written here, in a
  commit, before any test person is read. The test run happens once; its numbers are the result.

**Variants in one run.** A policy spec may carry its own knobs and an opening block, so a hypothesis is one run:
`jev-eig[ref=pool,tsel=1,short=8]` (knobs `ent`, `short`, `refsize`, `tsel`, `floor`, `ref` = `R` or `pool`), and
`open10-pop-eig` (the first 10 from the static questionnaire, then `pop-eig`). `ref=pool` aims a policy at a fixed
sample of the person's own pool questions instead of R: no knowledge of the decisions to be scored.

**Read without Jev.** Beside Jev's curves, the persona posterior reads the same targets from the same asked answers
(`populationReader`): what each policy's answers say about the targets, apart from how well Jev reads them. If a
policy's answers carry more and Jev doesn't gain from them, the bottleneck is reading, not asking. A yardstick only
(cross-person data, ADR-0071), never a predictor Mimic serves.

**Stopping on the policy's own score (H8).** Each step records the chosen item's score (its expected gain or entropy).
The report stops each person before the first question (from the fourth on) whose score falls below τ, at five
quantiles of the observed scores, and compares their accuracy where they stopped with a fixed length asking the same
mean number of questions.

## 8. Running it

```
pnpm eval -- curves --data data/twin-full.jsonl --role dev --people 150          # round 1, all eight policies
pnpm eval -- curves --data … --policies random,jev-eig --shortlist 10 --ref-size 30   # one hypothesis
pnpm eval -- curves --data … --offline --people 6                                  # machinery only, no spend
```

Live runs need OpenRouter (`OPENROUTER_API_KEY`; in the Claude Code remote env the proxy injects it). The default cap
is $60; the cache lives in `data/curves-cache`.

## 9. What it can't show

- **Twin people are not Mimic users.** Twin ranks policies for Jev on Twin's questions (`docs/RESEARCH.md` §8). The
  winner goes to real users as an arm, never as a default.
- **A fixed pool, not generated questions.** Mimic generates candidates per person, so a policy that needs other
  people's answers to the same item (`pop-static`, `pop-eig`, `hybrid`) can't run on generated questions; it can
  inform the opening block (`docs/RESEARCH.md` §1.1) and stable reserve items. Jev-only policies port directly.
- **The reference is known.** R and T come from the same wave 4 survey, so a policy that reads R knows the kind of
  decision it will be judged on. Mimic's reference would be its probe bank or the decisions a person cares about
  (`docs/RESEARCH.md` §1.3).
- **One draw of Jev.** The cache fixes each request's first answer; differences below about 0.01 nats are within
  Jev's own noise.
