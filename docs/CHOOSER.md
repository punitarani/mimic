# E10: who picks the next question (ADR-0074)

E9 (`docs/CURVES.md`) found that the questions Mimic asks matter more than how many. It found that Jev's own
uncertainty, the selector's information term, picks badly, and that statistics from other people pick well but don't
port to generated questions. Its confirmed win is a fixed opening: political views and income, asked once the trust
ramp opens (`cfg.e9.opening`, ADR-0073). After that opening, random picks gain little, and mostly on pricing decisions.

E10 asks who should pick the questions after the opening:
- Jev, choosing from the batch of candidates production keeps in its pool.
- An LLM, choosing from that batch.
- An LLM, writing a new question.
- Jev deciding between the batch and a newly written question.

Each sees only the person's own answers and the question texts, so each ports to generated questions.

Twin people rank the designs for Jev on Twin's questions; they never stand in for a Mimic user (`docs/RESEARCH.md` §8).
Results from LLM-simulated users are never reported. A winner reaches real users only as an arm.

## 1. Setting

The harness is E9's: `pnpm eval -- curves`, with the people, the R/T split, the sealed states, the per-(policy, k)
leave-one-person-out temperatures and the request cache all as in `docs/CURVES.md` §3–5. The Mimic setting is:

```
--given Demographics,-QID20,-QID21,-QID22 \
--opening QID234/3,QID32,QID34,QID26/1,QID239/1,QID33,QID22,QID21 --seed e9 --beta 0.25
```

Every `custom-…` policy asks E9's eight-question opening, then its own picks for questions 9–30. Two things emulate
production after the opening:

- **The batch** (`b=12`): each step draws a batch from what is open, as production's pool holds 6–15 candidates. The
  draw is seeded by the person and the step only (`batchOf`). So policies at the same point see the same batch, and a
  smaller batch is the start of a larger one.
- **The trust ramp** (`ramp=6`): Twin's party, income and political-views items stay out of batches before six
  answers. This matters only for runs without the opening.

## 2. Choosers (`packages/eval/src/curves/choosers.ts`)

| Policy | What picks | Knobs |
| --- | --- | --- |
| `jev-pick` | One Decisions API request. `form=choice`: the candidates are criteria under neutral keys (`q01…`, seeded order). `form=noul`: a yes/no per candidate. `form=score`: a 0–4 score per candidate. | `b` (1–48), `form`, `aim`, `state`, `lag` |
| `llm-pick` | An LLM (`llm`: DeepSeek V4.1 Flash by default, or GLM 5.3 Flash, GPT-6 Luna, MiMo or Qwen, each at its measured `predict.v2` settings) returns `{"key"}` from the candidates. | `b` (0 = everything open), `aim`, `state`, `lag`, `llm` |
| `llm-gen` | The LLM writes `n` questions. Each is grounded to the open item nearest by cosine of bge-base embeddings, so the person's recorded answer stands in. With `n` > 1, Jev picks among the grounded items. | `n`, `aim`, `lag`, `llm` |
| `jev-gate` | `jev-pick` with an extra "none of these: write a new question" criterion. When it wins, or the best candidate is below `thr`, `llm-gen` writes one. | `b`, `thr`, `aim` |

The knobs:
- **`aim`**: what the chooser is told Mimic predicts.
  - `p` is the product's own statement (`curves.purpose.v1`).
  - `r` is five of the person's R questions (never an answer).
  - `none` says nothing.
- **`state=off`**: the chooser sees the candidates alone. A person-blind score can be computed when the question is
  drafted, with no wait at serve time.
- **`lag=1`**: the chooser does not yet see the latest answer. This emulates choosing while the person answers.

Prompts are in `docs/prompts/curves/`. A chooser never throws: on any failure it picks a seeded random candidate and
logs why. Every decision goes to `choices.jsonl` with:
- the candidates shown and the pick;
- probabilities, the text written and its grounding similarity;
- latency on uncached calls, and cost.

The report summarizes these (§5).

**References** (not portable, ceilings only): `custom-pop-eig[b=12]` and `custom-jev-lift[b=12]`.

## 3. Hypotheses

- **H0, headroom.** Within a batch of 12 after the opening, some pick is better than random. If no ceiling beats
  random, there is nothing for a chooser to find, and E10 stops there.
- **H1.** `jev-pick` beats a random pick from the same batch.
- **H2.** `llm-pick` beats random, and beats `jev-pick`.
- **H3.** `llm-gen` beats picking from a batch, because it can reach any question.
- **H4.** `jev-gate` beats both always picking and always writing, at lower cost.

## 4. Stages

| Stage | People | Cap | Decides |
| --- | --- | --- | --- |
| 1 Pilot | dev 1–20 | $3 | Plumbing on live models: parse and fallback rates, position bias, p(max), latency, $/person. Prompt fixes become new IDs. |
| 2a Headroom | dev 1–150 | $4 | The bench oracle (below) and the ceilings. **Futility:** no headroom ends E10. |
| 2b Screen | dev 1–150 | $8 | The bench for every portable chooser and variant. Keep those whose gain over random has an interval above 0, else the top two. |
| 2c Walks | dev 1–150 | $10 | Full walks of the survivors. Up to three finalists. Stop iterating at two rounds under 0.002 nats. |
| 3 Selection | dev 151–300 | $6 | Finalists against `custom-random`. Pick one. Skip confirmation if its point estimate is above −0.002 (underpowered). |
| 4 Confirm | dev 301–609 | $10 | Pre-registered here (§6) before the run; read once. Decides the arm. |

All 397 test people were read by E9 (§T and round 5). Dev people 301–609 have never been read by a Jev-scored run;
E9's round 2p read every dev person with the population reader alone, with no model calls. They are E10's
confirmation people (ADR-0074).

**The decision-point bench** (`--bench 8,14,21`, `bench.ts`) is for screening only:
1. Each person is walked by `custom-random`.
2. After 8, 14 and 21 answers, every candidate of a 24-item batch is scored by what its answer would do for Jev on the
   person's targets: the change in log loss (temperature 4) and in accuracy when that one answer joins the state.
3. Each chooser is then asked to pick from that same state and its own batch (the start of the 24). It is scored by
   its pick's gain over the batch mean (what a random pick gets on average), its regret against the batch's best, and
   how often it picked the best.
4. The oracle, the best pick in each batch against the mean, is the headroom.

T answers score here and are never shown to a chooser. The bench looks one step ahead only, so the full walks decide.

## 5. Rule and report

`CHOOSER_RULE` (`packages/eval/src/curves/analyze.ts`, `--rule chooser`): a chooser beats `custom-random` when, on at
least 30 people, its AULC over k = 10, 15, 20, 25 and 30 has a 90% interval by person below 0, and its accuracy at 30
is at most a point lower.

Every `custom-…` policy asks the same eight questions first, so checkpoints at k ≤ 8 cannot differ, and AULC leaves
them out.

Reported but deciding nothing:
- AULC deltas on pricing and on heuristics and biases;
- for each chooser:
  - how it decided;
  - the fallback rate;
  - the gate's rate (how often a user would wait for a written question);
  - position by fifth of the shown list (uniform is 20% each);
  - median p;
  - grounding similarity quartiles;
  - latency p50/p95 on uncached calls;
  - $ per step.

## 6. Confirmation (to be pre-registered before stage 4 runs)

Written after stage 3 and merged before any of dev people 301–609 are read.
