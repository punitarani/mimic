# E10 readout: who picks the next question (ADR-0074)

**Status: interim.** Stages 1 and 2a ran on 2026-10-03. The pilot stopped when the OpenRouter account ran out of
credits at 07:35 UTC (HTTP 402, `limit_source: openrouter_credits`; total usage $190.44 against $190 of credits). Stages
2b–4 wait for credits.

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

## Next, once credits are added

- **2b, the screen:** the bench (`--bench 8,14,21`, gains already cached) for:
  - `jev-pick` in each form, with `state=off` and `aim=r`;
  - `llm-pick[llm=luna]` with `aim` and `lag`;
  - `llm-gen[llm=luna]` with `n=1` and `n=3`;
  - `jev-gate[llm=luna]`.

  About $1 with Luna.
- **2c:** walks of the survivors on dev 1–150.
- **3:** selection on dev 151–300.
- **4:** pre-registered confirmation on dev 301–609.
