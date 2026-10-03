# E9 readout: which question to ask next (ADR-0071)

The design and `CURVES_RULE` were fixed in `docs/CURVES.md` before the first run. The rounds read **dev** people: they
are for iteration, not results. The result is the confirmatory run on test people (§T), pre-registered in
`docs/CURVES.md` §10. Twin people rank selection policies for Jev on Twin's questions; they never stand in for a Mimic
user (`docs/RESEARCH.md` §8).

**Result.** In the setting Mimic is in (demographics known, politics and money asked only after the trust ramp), an
opening that asks the person's political views and income once the ramp opens beats production's opening for Jev:
AULC log loss −0.031 [−0.040, −0.023] and +2.5 points of accuracy at 30 questions on 200 test people. The gain comes
from those two questions, mostly on decisions about policies; the opening's money-and-possessions questions add
little. Jev's own uncertainty, the selector's information term, is no better than random at choosing (round 1, 4b).

## Round 0: the long horizon (dev, 150 people)

Run `01M3YVECWN2VQAA1HR59DHXAHC`, $2.83: `random`, `order` (survey order, as E6 and E8 ask) and `pop-eig` out to 120
answers, to see where learning flattens.

| Policy | k = 0 | 3 | 10 | 30 | 60 | 120 | AULC (3–30) | Δ AULC vs random |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pop-eig` | 0.946 / 60.1% | 0.924 / 62.3% | 0.916 / 64.5% | 0.915 / 65.3% | 0.912 / 64.9% | 0.902 / 64.8% | 0.9175 | −0.027 [−0.038, −0.016] |
| `order` | 0.946 / 60.1% | 0.944 / 59.1% | 0.924 / 60.3% | 0.914 / 63.2% | 0.913 / 63.6% | 0.902 / 64.8% | 0.9234 | −0.021 [−0.031, −0.011] |
| `random` | 0.946 / 60.1% | 0.948 / 62.8% | 0.944 / 63.1% | 0.941 / 61.7% | 0.937 / 62.5% | 0.931 / 63.4% | 0.9442 | — |

Calibrated log loss / accuracy on the T targets; the people's own test–retest agreement on them is 83.4%.

1. **What is asked matters more than how much.** `pop-eig` reaches `order`'s accuracy at 120 answers after about 13
   (interval 6.9 to beyond 120), and leads it by 3.0 points of AULC accuracy.
2. **Jev's curve flattens early.** Under `pop-eig` it levels at about 65%, a fidelity of 78% (accuracy ÷ the people's
   own retest agreement), by 10–15 answers; `order` gets there only at 120, and `random` not at all.
3. **Jev's ceiling here is the base rate.** After 120 answers Jev's log loss (0.902) equals what the train people's
   answer frequencies give with none (0.902, the population reader at k = 0).
4. **The persona posterior, read directly, overfits.** As a reader its accuracy falls from 60.4% to about 58% as
   answers accumulate: it concentrates on a few look-alike train people. Hence the temper β (round 2).

## Round 1: eight policies (dev, 30 people)

Run `01M3YWM0FX7M2F5ZT23K5HRVMH` (rebuilt from the request cache): the first 30 of 150 dev people. The workspace's
daily OpenRouter budget ($25) ran out at 17:48 UTC during the 150-person run; the outage guard (added after it) drops
any chunk with failed predictions, so 30 people are clean.

| Policy | Verdict | AULC Δ log loss vs random | AULC log loss | AULC accuracy | Accuracy at 30 | Pricing / H&B accuracy at 30 |
| --- | --- | --- | --- | --- | --- | --- |
| `pop-eig` | better | −0.043 [−0.076, −0.011] | 0.9069 | 64.7% | 64.9% | 63.6% / 67.0% |
| `pop-static` | better | −0.038 [−0.068, −0.006] | 0.9122 | 63.4% | 63.7% | 62.7% / 65.2% |
| `hybrid` | better | −0.032 [−0.057, −0.006] | 0.9174 | 62.5% | 64.3% | 61.5% / 68.6% |
| `order` | better | −0.027 [−0.053, −0.004] | 0.9224 | 60.8% | 62.8% | 59.2% / 68.3% |
| `stratified` | better | −0.022 [−0.038, −0.006] | 0.9281 | 61.6% | 61.7% | 58.5% / 66.6% |
| `jev-eig` | level | −0.001 [−0.008, +0.006] | 0.9488 | 64.8% | 64.3% | 65.2% / 62.9% |
| `random` | — | — | 0.9498 | 62.7% | 61.6% | 61.2% / 62.3% |
| `jev-entropy` | level | +0.004 [−0.002, +0.010] | 0.9539 | 64.4% | 64.5% | 65.6% / 62.7% |

1. **Jev's own uncertainty doesn't find what to ask.** `jev-entropy` (production's info term without hypotheses) and
   Jev's lookahead over R (`jev-eig`) are level with random on log loss. They gain accuracy on the pricing decisions
   (65% against 59–63%) by asking economic-preference items, and lose it on heuristics and biases.
2. **Population information does.** Every policy that chooses with the train people's answers (`pop-eig`,
   `pop-static`, `hybrid`) beats random, on both target groups. `hybrid` (the population shortlists, Jev's lookahead
   picks) is no better than `pop-eig` alone: Jev's rerank adds nothing.
3. **Survey order is a strong baseline** because it starts with demographics; its weakness is the 60 Big Five rows
   after them (round 0).
4. **The static questionnaire** (the same for everyone, chosen on train people) opens with a syllogism, political
   views, household size, income, a mental-accounting scenario, two vocabulary items, anxiety, spending anxiety,
   region, race, the trust game, age and spending. Reasoning, identity and money, not personality rows.
5. **Stopping on the policy's own score saves nothing yet** (−0.9 to +0.3 points against a fixed length of the same
   mean), and `pop-eig`'s curve is flat after 10–15, so a fixed length there is close to optimal.

## Round 2p: what the answers say without Jev (dev, all 609 people, no model calls)

Free rounds with `--no-jev`: the persona posterior over the 1,052 train people reads the targets from the asked
answers (`populationReader`). It ranks what each policy's answers carry; it is not Jev, and (below) it is a yardstick
for the first answers only.

**The reader needs a temper.** Untempered (β = 1) it gets worse with every answer after the first few (0.898 at k = 0,
0.933 at 30 under `order`); β = 0.25 is the best of 1, 0.5, 0.25 and 0.1 (300 people: `order` AULC 0.8755 against
0.8865 at 0.1, 0.8930 at 0.5 and 0.9204 at 1). Every round below reads at β = 0.25.

Run `01M3YYHZDT9XGBYAR58M6NH27D` (2p-a), fixed and statistic policies; the reader sweep is runs `01M3YXQ…`–`01M3YXR…`:

| Policy | AULC log loss | Δ vs random | Δ vs order | Accuracy at 30 |
| --- | --- | --- | --- | --- |
| `order` | 0.8718 | −0.0165 [−0.0189, −0.0139] | — | 62.4% |
| `pop-transfer` | 0.8732 | −0.0151 [−0.0176, −0.0125] | +0.0013 [−0.0009, +0.0035] | 62.7% |
| `stratified` | 0.8787 | −0.0096 [−0.0118, −0.0076] | +0.0069 [+0.0048, +0.0088] | 62.6% |
| `pop-static` | 0.8795 | −0.0088 [−0.0113, −0.0065] | +0.0076 [+0.0054, +0.0098] | 61.6% |
| `random` | 0.8883 | — | +0.0165 [+0.0139, +0.0189] | 62.1% |
| `pop-entropy` | 0.8942 | +0.0059 [+0.0042, +0.0076] | +0.0223 [+0.0193, +0.0252] | 60.9% |

1. **Production's population statistic points the wrong way.** `pop-entropy` asks the items people disagree on most,
   the answer-entropy half of `item_stats`' `pop(q)` (`docs/SELECTION.md` §7). It is worse than random: those items
   (price lists, lotteries) differ between people without saying anything about their other answers.
2. **Transfer is the statistic that works.** `pop-transfer` ranks items once by their mutual information with the
   reference questions across the train people, Σ_r I(A_c; A_r), with no conditioning on the person. It ties survey
   order, which starts with the demographics, and asks the syllogism or political views first.
3. **The posterior should plan with the temper it reads with.** `pop-eig` at β = 0.25 beats random by −0.0136
   [−0.0160, −0.0112]; at β = 0.5 by −0.0087 and at 1 by −0.0083 (runs `01M3Z1HJ9GPD9M15WMSX3AHG42`,
   `01M3Z1TGSG8R5ZZWZ3CMY34FEH`). Under this reader it still trails `order` (+0.003).
4. **Aim at the decisions, not at the person.** The same posterior aimed at a sample of the person's own pool questions
   (`ref=pool`, information about the person in general) is level with random: +0.0002 [−0.0015, +0.0020]. What helps
   is information about the kind of decision that will be predicted.
5. **The reader is a yardstick for the first answers only.** Read in survey order, every population reader (the train
   people at β = 1, 0.25 or 0.1, or 8–32 latent classes) improves through the demographics and then degrades as dozens
   of personality rows outweigh them (a naive-Bayes over-count: each row is weighted as if independent). So the rounds
   below rank policies with it early and leave the verdict to Jev.

**What carries information about decisions.** `pop-transfer`'s statistic, each pool question's mutual information with
the 43 reference questions across the 1,052 train people (Σ_r I(A_c; A_r), no conditioning), by block:

| Block | Questions | Mean transfer (nats) | Highest |
| --- | --- | --- | --- |
| Demographics | 9 | 0.040 | 0.078 (political views) |
| Cognitive tests | 43 | 0.034 | 0.080 (a syllogism) |
| Personality | 199 | 0.021 | 0.060 (consumer uniqueness) |
| Economic preferences | 169 | 0.014 | 0.041 |

The top ten are a syllogism, political views, two vocabulary items, consumer uniqueness ("I actively seek to develop
my personal uniqueness by buying special products"), household size, a third vocabulary item, party, trouble limiting
spending and a fourth vocabulary item. Lotteries and time preferences, the kind of question production's anchors open
with, carry the least.

## Round 3: what Mimic knows and may ask (dev, population reader)

Mimic is not Twin's survey. Identity supplies some demographics before the first question, and politics and money are
sensitive areas: consented by default, but held back for the first six answers (the trust ramp) and swept later
(ADR-0044). Three free runs approximate that with `--given` and `--drop`:

| Run | Setting | `order` | `pop-transfer` | `pop-static` | `anchors-random` | `random` |
| --- | --- | --- | --- | --- | --- | --- |
| 3a `01M3YZTP57Z271BEV350YGFE2A` | six demographics given; party, income and views dropped | +0.0025 | +0.0052 | +0.0076 | −0.0002 | 0.8864 |
| 3b `01M3Z12DHHXTGN57WMZ3ZHWZSV` | six demographics given; party, income and views askable | −0.0180 | −0.0123 | −0.0076 | +0.0015 | 0.8853 |
| 3c `01M3Z1HQE65Y36SEAT934D3BEJ` (300 people) | as 3a, and no vocabulary or health items | — | +0.0003 | −0.0002 | — | — |

AULC Δ log loss against random (random's own AULC in its column).

1. **Politics and money carry the population's information about decisions.** With them askable (3b), survey order,
   whose first three questions are then party, income and political views, gets nearly all its gain by k = 3
   (0.890 → 0.866). With them dropped (3a), nothing beats random, and the policies that plan with the population get
   worse as answers accumulate.
2. **Production's opening is level with random** in every setting (`anchors-random`: the closest Twin question to each
   of `anchors.v1`'s ten, in a per-person order). Its Big Five markers, lottery and time rows carry little about the
   decisions here.
3. **The best fixed opening among questions Mimic would ask** (3c: no vocabulary quizzes, health items or sensitive
   areas) is a syllogism, consumer uniqueness, the two spending scales, the Mr A/B shopper, a second syllogism,
   financial literacy, the trust game and two maximizing items; under the population reader it too is level with
   random.

The population reader cannot tell whether Jev gains from these questions; round 4 asks Jev.

## Round 4: the Mimic setting, read by Jev (dev, 150 people)

Run `01M3ZM2WY853Q09Z65FAH0663H`, $4.55: the six non-sensitive demographics given; party, income and political views
askable. A rehearsal of the pre-registered set (`docs/CURVES.md` §10) plus `sem-ref` and `pop-eig` over the train
people.

| Policy | AULC log loss | Δ vs random | Δ vs `anchors-random` | Accuracy at 30 |
| --- | --- | --- | --- | --- |
| `pop-eig` (β = 0.25) | 0.9122 | −0.0285 [−0.0411, −0.0162] | −0.0265 [−0.0391, −0.0135] | 65.0% |
| `custom-random` (the arm's opening) | 0.9192 | −0.0216 [−0.0308, −0.0119] | −0.0195 [−0.0289, −0.0106] | 64.1% |
| `jev-lift` | 0.9306 | −0.0101 [−0.0165, −0.0039] | −0.0081 [−0.0142, −0.0022] | 64.4% |
| `anchors-random` (production today) | 0.9387 | −0.0020 [−0.0060, +0.0020] | — | 63.0% |
| `custom6-random` (the opening without its two sensitive questions) | 0.9394 | −0.0014 [−0.0049, +0.0022] | +0.0007 [−0.0030, +0.0043] | 63.4% |
| `pop-eig[cls=16]` | 0.9396 | −0.0011 [−0.0059, +0.0034] | +0.0009 [−0.0033, +0.0050] | 62.7% |
| `random` | 0.9407 | — | +0.0020 [−0.0020, +0.0061] | 62.6% |
| `sem-ref` | 0.9411 | +0.0003 [−0.0029, +0.0036] | +0.0024 [−0.0010, +0.0054] | 63.8% |

1. **What helps Jev here is asking political views and income once the ramp opens.** The arm's opening drops from
   0.941 at k = 6 to 0.914 at k = 10, right after its two sensitive questions (questions 7 and 8); the same opening
   without them (`custom6-random`) is level with production's anchors. `pop-eig` asks political views first for 115 of
   150 people and is ahead from k = 3.
2. **The gain is concentrated in one kind of decision.** By target block (mean calibrated log loss, k = 3–30, from the
   request cache): false consensus, where people rate policies, 1.602 under production's anchors and 1.543 under the
   arm's opening; pricing 0.668 and 0.664; the other heuristics-and-biases blocks move by less than 0.02 either way.
   Political views predicts political opinions; it says little about prices.
3. **Production's opening is level with random for Jev too**, and so are the money-and-possessions questions on their
   own: the population's and Jev's readings agree on that.
4. **Jev's own measure finds what the population's misses, slowly.** `jev-lift` asks Mr A/B, time-preference rows,
   financial literacy and maximizing first (the largest single-answer lifts on R, −0.017 to −0.032 nats); it gains
   accuracy from the start and log loss from k = 20: it asks political views 17th (its lift on R ranks there), and income
   never (its lift on R is slightly positive). What a question is worth depends on the decisions it is scored on: R
   holds fewer policy items than T, so a lift measured on R undervalues political views for T.
5. **Latent classes do not carry `pop-eig`'s gain** (level with random), so an aggregate-only port of adaptive
   population selection does not work as built; `sem-ref` (semantic relevance to the decisions) gains accuracy but not
   log loss.

## §T: the confirmatory run (test people, pre-registered)

Run `01M3ZMY3S44GMQYXKGTNW1XQ50`, $3.78, 200 test people, read once, exactly as `docs/CURVES.md` §10 fixed it before
any Jev-scored run of this setting. No outage, no early stop.

| Policy | AULC log loss | Δ vs random | Δ vs `anchors-random` | Accuracy at 30 | Fidelity at 30 |
| --- | --- | --- | --- | --- | --- |
| `custom-random` (`cfg.e9.opening`) | 0.9086 | −0.0367 [−0.0448, −0.0282] | **−0.0308 [−0.0396, −0.0225]** | 64.8% | 76.6% |
| `jev-lift` | 0.9240 | −0.0213 [−0.0264, −0.0159] | −0.0154 [−0.0206, −0.0098] | 64.8% | 76.6% |
| `anchors-random` (production today) | 0.9394 | −0.0059 [−0.0089, −0.0029] | — | 62.3% | 73.7% |
| `pop-eig[cls=16]` | 0.9399 | −0.0054 [−0.0086, −0.0023] | +0.0005 [−0.0030, +0.0039] | 62.7% | 74.1% |
| `custom6-random` (no sensitive two) | 0.9426 | −0.0027 [−0.0056, −0.0001] | +0.0032 [+0.0003, +0.0061] | 63.1% | 74.6% |
| `random` | 0.9453 | — | +0.0059 [+0.0029, +0.0090] | 62.2% | 73.5% |

Fidelity is accuracy ÷ the people's own test–retest agreement on the same targets (84.6%).

**Rule 1 (`CURVES_RULE`, every policy against random):** all five beat random.

**Rule 2 (primary): the opening beats production's.** The interval of `custom-random` − `anchors-random` lies below 0
(−0.0308 [−0.0396, −0.0225]) and its accuracy at 30 is 2.5 points higher [+1.4, +3.6], not lower. By the rule,
`cfg.e9.opening` goes to real people as the `e9` preset (draft; ADR-0073).

**Secondary (no decision).**

1. **The two sensitive questions carry it.** The curve drops from 0.943 at k = 6 to 0.896 at k = 10, right after
   political views and income (questions 7 and 8). Without them (`custom6-random`) the opening is slightly worse than
   production's on log loss (+0.0032 [+0.0003, +0.0061]) and better on accuracy (+1.3 points).
2. **Mostly on decisions about policies.** By target block (mean calibrated log loss, k = 3–30, from the request
   cache), production's anchors → the opening: false consensus (rating policies) 1.605 → 1.522; pricing 0.671 →
   0.660; anchoring (African countries, low) 0.634 → 0.607, (redwood, high) 0.631 → 0.612; the other blocks move by
   less than 0.01.
3. **Jev's own measure works, from train people alone.** `jev-lift` beats production's anchors (−0.0154 [−0.0206,
   −0.0098]) and has the highest accuracy from the third question (65.9%); it reaches political views at question 17.
4. **The class model does not carry the population's gain** (level with production's anchors), so adaptive population
   selection has no aggregate-only form yet.

**What it means for Mimic.** Once a person has consented to politics and money and answered six questions, asking
their political leaning and financial situation next is the most valuable thing the session can do for predictions
of the decisions those touch. Twin's decisions over-represent policy opinions (2,000 of 7,164 scored instances), so
the size of the gain on Mimic's decisions is for the arm to show on real people. E7's probes, which never touch a
sensitive facet, measure the part that transfers to other decisions; Twin suggests it is real but small (pricing
0.671 → 0.660).

