# E10 readout: who picks the next question (ADR-0074)

**Status: interim.** Stages 1, 2a, 2b and round 1 of 2c ran on 2026-10-03; round 2 is running. The pilot stopped when the OpenRouter
account ran out of credits at 07:35 UTC (HTTP 402, `limit_source: openrouter_credits`; total usage $190.44 against
$190 of credits). Credits were added by 10:48 UTC and the screen ran then.

Design and rules: `docs/CHOOSER.md`. Every number here comes from dev people. Twin people rank designs for Jev on
Twin's questions; they never stand in for a Mimic user.

## What it found so far

1. **The headroom after E9's opening is small, and it is in log loss, not accuracy.**
   - On 96 dev people, at the pick after 8, 14 and 21 answers, the best of a 12-question batch beats a random pick by
     −0.0058 nats [−0.0080, −0.0038] per question, cross-fitted.
   - It adds +0.03 points of accuracy [−0.17, +0.21], so none.
   - Picked in-sample, the best looks four times better (−0.0187 nats, +3.7 points). Most of that is choosing noise.
   - So a chooser can make each later answer sharpen Jev's probabilities a little. It cannot make Jev right more often
     on these targets.
2. **The population posterior finds none of that headroom** inside a batch (`pop-eig[b=12]` +0.0001 [−0.0016,
   +0.0017]). After the opening, the cross-person signal that made `pop-eig` E9's best dev policy is spent: political
   views and income are already asked.
3. **Speed decides what can serve.** Choosing from 12 candidates after 10 answers:

   | Chooser | Latency per pick | Cost per pick |
   | --- | --- | --- |
   | Jev (`jev-pick`, one Decisions request) | 280 ms mean (880 pilot calls) | $0.0002 |
   | GPT-6 Luna, effort low | 2.5–4.4 s (3 calls) | $0.0003 |
   | MiMo V2.6 Flash, 1024-token budget | 5–32 s, one 502 (3 calls) | $0.0003–0.0007 |
   | GLM 5.3 Flash, effort low | 9–16 s (3 calls) | $0.0007–0.0015 |
   | Qwen3.8 Flash, 1024-token budget | 18–20 s (3 calls) | $0.0008 |
   | DeepSeek V4.1 Flash, effort low (Wafer) | 39 s mean, 90 s timeouts (59 calls); about 1,800 output tokens | $0.0012 |

   Under the 5 s budget only Jev and Luna fit. DeepSeek, the default LLM, would need a prefetch (`lag=1`) or the pool
   refill to choose at all.
4. **Pilot, Jev's three forms, 10 people (too few to decide anything).**
   - AULC (k = 10–30) against `custom-random`:
     - yes/no per candidate (`form=noul`): −0.0063 [−0.0124, −0.0006];
     - one choice (`form=choice`): +0.0039 [−0.0016, +0.0086];
     - a 0–4 score (`form=score`): +0.0010 [−0.0029, +0.0045].
   - Jev favours candidates shown first: 32% of `form=choice` picks and 31% of `form=noul` picks fall in the first
     fifth of the list (uniform is 20%). `form=score` is flatter (22%).
   - None failed or fell back in 660 picks.

Spend: the headroom bench cost $3.25. The pilot cost $0.47 before the credits ran out. The pilot's LLM choosers did
not finish, so its 20-person chunk was dropped, and no LLM chooser result exists yet.

## Stage 2b: the screen (100 dev people, $1.38, run after credits were added)

Each chooser picks from the same 12-candidate batch, after 8, 14 and 21 answers. It is scored by its pick's one-step
gain on the person's targets over the batch's mean gain, which is what a random pick gets on average. Intervals are
90%, by person.

| Chooser | Δ log loss vs random | Δ accuracy, points | Latency p50 / p95 |
| --- | --- | --- | --- |
| `random[b=12]` (control) | −0.0017 [−0.0037, +0.0002] | +0.11 [−0.11, +0.34] | — |
| `llm-gen[llm=luna]` | −0.0010 [−0.0025, +0.0005] | +0.03 [−0.22, +0.27] | 4.1 / 8.4 s |
| `llm-gen[llm=luna,n=3]` | −0.0009 [−0.0026, +0.0006] | −0.16 [−0.42, +0.11] | 4.2 / 5.7 s |
| `jev-pick[form=noul,aim=r]` | −0.0003 [−0.0018, +0.0012] | −0.01 [−0.28, +0.26] | 0.30 / 0.49 s |
| `llm-pick[llm=luna]` | +0.0004 [−0.0009, +0.0017] | +0.08 [−0.15, +0.31] | 3.6 / 5.3 s |
| `jev-pick[form=noul]` | +0.0006 [−0.0007, +0.0020] | −0.30 [−0.53, −0.08] | 0.28 / 0.46 s |
| `jev-pick[form=noul,state=off]` | +0.0006 [−0.0005, +0.0018] | −0.02 [−0.21, +0.17] | 0.27 / 0.49 s |
| `jev-pick[form=noul,aim=none]` | +0.0007 [−0.0005, +0.0020] | −0.22 [−0.46, +0.04] | 0.27 / 0.41 s |
| `jev-pick[form=score]` | +0.0008 [−0.0003, +0.0020] | −0.05 [−0.24, +0.15] | 0.29 / 0.40 s |
| `jev-gate[llm=luna]` | +0.0013 [−0.0001, +0.0026] | −0.11 [−0.36, +0.14] | 0.28 / 0.42 s |
| `jev-pick` (choice) | +0.0014 [+0.0001, +0.0029] | −0.14 [−0.36, +0.10] | 0.28 / 0.43 s |
| `llm-pick[llm=luna,lag=1]` | +0.0016 [+0.0002, +0.0031] | +0.12 [−0.12, +0.36] | 3.6 / 5.4 s |
| `llm-pick[llm=luna,aim=r]` | +0.0019 [+0.0006, +0.0032] | +0.04 [−0.19, +0.26] | 3.8 / 6.0 s |

Against the cross-fitted headroom of −0.0060 [−0.0081, −0.0041] for a batch of 12:

1. **No chooser finds the better questions.** None is below random with an interval below 0. Three are slightly
   worse: Jev's choice form, and Luna with `aim=r` or `lag=1`. The best two, the LLM writing a question, recover
   about a sixth of the headroom, within noise. Jev and an LLM read the person and the candidates, but neither can
   tell which answer Jev will learn the most from.
2. **Jev almost never asks for a written question.** In `jev-gate`, "none of these" won once in 300 steps, so
   choosing between the batch and generation reduces to Jev's pick.
3. **Choosers that can't tell candidates apart lean on position.** 31% of Jev's picks and 34% of Luna's fall in the
   first fifth of the shown list (uniform is 20%), with neutral keys in a seeded order.
4. **Written questions ground loosely.** Luna's questions are plausible everyday ones ("If you unexpectedly received
   $1,000, what would you most likely do with it?"). They map to the nearest recorded item at a median cosine of 0.68,
   and Luna takes 4 s a question at the median and 8.4 s at the 95th percentile.

By the screen's rule (§4: none beats random, so the top two go on), stage 2c walks `llm-gen[llm=luna]` with `n=1` and
`n=3`, plus Jev's yes/no form, whose 10-person pilot had looked best, against `custom-random`.

## Stage 2c, round 1: full walks (dev 1–150, $4.90)

Each policy asks E9's opening, then picks questions 9–30. Jev predicts the targets after 0, 8, 10, 15, 20, 25 and 30
answers, and each (policy, k) has its own leave-one-out temperature. `CHOOSER_RULE` compares AULC over k = 10–30
against `custom-random`.

| Policy | Verdict | AULC Δ log loss | AULC Δ accuracy | Δ log loss at 30 | Pricing Δ log loss | $ / pick | Latency p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `custom-random[b=12]` | level | +0.0002 [−0.0027, +0.0029] | +0.1 | +0.0024 [−0.0014, +0.0061] | −0.0002 | — | — |
| `custom-jev-pick[b=12,form=noul]` | level | −0.0007 [−0.0027, +0.0011] | −0.2 | −0.0052 [−0.0092, −0.0010] | −0.0010 [−0.0018, −0.0002] | $0.0002 | 0.28 / 0.41 s |
| `custom-llm-gen[llm=luna]` | level | +0.0002 [−0.0017, +0.0021] | +0.1 | +0.0023 [−0.0007, +0.0053] | −0.0006 | $0.0003 | 3.0 / 4.6 s |
| `custom-llm-gen[llm=luna,n=3]` | level | −0.0001 [−0.0019, +0.0019] | +0.2 | +0.0017 [−0.0014, +0.0048] | −0.0012 | $0.0005 | 3.8 / 5.1 s |

The walks agree with the screen: nothing beats random picks after the opening. Writing questions with Luna is level,
costs 3–4 s a question, and grounds at a median cosine of 0.66. Jev's yes/no form is the one faint signal: level over
k = 10–30, but ahead by question 30 and on pricing. Round 2 tests its two best-motivated variants. One is told the
decisions to predict (`aim=r`, the bench's best Jev form). The other picks from 24 (`b=24`, the most headroom).

## Next

- **2b, the screen:** the bench (`--bench 8,14,21`, gains already cached) for:
  - `jev-pick` in each form, with `state=off` and `aim=r`;
  - `llm-pick[llm=luna]` with `aim` and `lag`;
  - `llm-gen[llm=luna]` with `n=1` and `n=3`;
  - `jev-gate[llm=luna]`.

  About $1 with Luna.
- **2c:** walks of the survivors on dev 1–150.
- **3:** selection on dev 151–300.
- **4:** pre-registered confirmation on dev 301–609.
