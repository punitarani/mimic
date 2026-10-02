# E9 readout: which question to ask next (ADR-0071)

The design and `CURVES_RULE` were fixed in `docs/CURVES.md` before the first run. Every round below reads **dev**
people: they are for iteration, not results. Twin people rank selection policies for Jev on Twin's questions; they
never stand in for a Mimic user (`docs/RESEARCH.md` §8). The confirmatory run on test people is §T.

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
