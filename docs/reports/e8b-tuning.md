# E8b readout: each decision model at its best (ADR-0069)

The grid, the nested selection and the bias controls were fixed in `docs/MODELS.md` §9 before this run. The rule is
`MODELS_RULE`, unchanged from E8 (`docs/reports/e8-models.md`).

## The run

| | |
| --- | --- |
| Workflow | Actions → Decision models with `tune`, run `36943686226` on `b053098`, 2026-10-01 23:59 to 2026-10-02 00:38 UTC |
| Eval run | `01M3X0RN76Y4C8WY6V8AJP1M9C` (in /lab → Eval runs) |
| Served data | The prod export: the same 9 consented real people and 462 served questions as E8, one per request |
| Twin data | Twin-2K-500 people 201–300 (`twin_offset=200`, `twin_people=100`), never read by E8 or by the grid's design: 2,000 held-out wave 4 items at k = 30, in batches of 20 |
| Models | Jev (`typesafe/jev-1.13-20260917`), span-01 (`respan/span-01-20260925`), clef (`@cf/cloudflare/clef`), clef-flash (`@cf/cloudflare/clef-flash`), Perplexity's decider (`pplx-decider-v1-27b`). GLiDE is supported and was left out (ADR-0070). |
| Settings | 10 per model on served questions, of which 6 are distinct on Twin (`answers` and `derived` reuse `full` and `context` at no cost). Each was scored with one temperature and with one per question type, so 20 configurations per model. |
| Timeout | 300 s for every vendor (`DECISION_TIMEOUT_MS`) |
| Spend | $5.96 of the $20 cap, with no budget stop: $3.64 on served questions, $2.32 on Twin |

All five canaries passed. In E8's tables one prediction failed (the decider's, on a served question), counted as
uniform. `tune` refuses settings that scored different instances, and it didn't refuse any.

## E8 again, on fresh Twin people

E8's tables read only E8's two settings, so the run repeats E8. The served people and questions are the same as in E8's
first run. The Twin people are new.

| Challenger − Jev | Served Δ log loss, run 1 → this run | Twin Δ log loss, people 1–200 → 201–300 | Δ item accuracy, served / Twin (points) |
| --- | --- | --- | --- |
| span-01 | +0.058 → +0.051 [+0.023, +0.078] | +0.053 → +0.051 [+0.038, +0.063] | −8.5 / −4.3 |
| clef | +0.022 → +0.015 [−0.008, +0.037] | −0.033 → −0.033 [−0.044, −0.022] | −3.0 / +5.3 |
| clef-flash | +0.018 → +0.011 [−0.018, +0.041] | −0.014 → −0.021 [−0.034, −0.009] | −3.6 / +4.6 |
| Perplexity's decider | +0.008 → +0.002 [−0.017, +0.020] | −0.025 → −0.025 [−0.033, −0.018] | −3.8 / +3.8 |

**E8's verdict replicates: keep Jev.** span-01 is `worse`, and the other three are `level`. On a hundred people the grid
never saw, the Twin ranking and every Twin gap repeat to within 0.007. Every served gap shrank by 0.006 or 0.007,
because Jev's own served score moved between runs (finding 5 below). For the first time a challenger passed the
operational checks: the decider's p95 was 626 ms against Jev's 534 ms, within 1.5×. It still fails on quality.

## Verdict (MODELS_RULE, tuned against tuned Jev): keep Jev

| Challenger | Outcome | Operational checks | Recommended |
| --- | --- | --- | --- |
| span-01 | `worse` | fail (latency) | no |
| clef | `level` | fail (latency) | no |
| clef-flash | `level` | fail (latency) | no |
| Perplexity's decider | `level` | fail (latency) | no |

Δ log loss is challenger − Jev, each at the configuration and temperatures chosen without the person scored. Served
intervals resample questions, Twin's resample people (90%). The family-wise column splits the rule's one-sided 5% across
the four challengers (a 97.5% interval by question). It is reported, not gating.

| Challenger | Served Δ log loss | Family-wise | Twin Δ log loss | Δ item accuracy, served / Twin (points) | People better / worse, served / Twin |
| --- | --- | --- | --- | --- | --- |
| span-01 | +0.051 [+0.012, +0.089] | [−0.003, +0.101] | +0.042 [+0.028, +0.056] | −8.9 / −4.7 | 3 / 6, 28 / 72 |
| clef | −0.002 [−0.031, +0.026] | [−0.040, +0.037] | −0.035 [−0.047, −0.023] | −2.8 / +5.1 | 4 / 5, 75 / 25 |
| clef-flash | −0.028 [−0.058, +0.005] | [−0.068, +0.017] | −0.029 [−0.040, −0.018] | −1.7 / +4.8 | 5 / 4, 68 / 32 |
| Perplexity's decider | −0.015 [−0.043, +0.012] | [−0.056, +0.019] | −0.027 [−0.037, −0.018] | −3.1 / +3.5 | 3 / 6, 66 / 34 |

| Model | p50 / p95 per request | $ per request |
| --- | --- | --- |
| Jev | 196 / 297 ms | $0.000219 |
| span-01 | 611 / 1,943 ms | $0.000105 |
| clef | 750 / 1,452 ms | $0.000575 |
| clef-flash | 534 / 1,023 ms | $0.000223 |
| Perplexity's decider | 311 / 626 ms | $0.000564 |

These are each model's tuned requests, served and Twin together.

- **No challenger's served interval lies below 0**, so none is `better`. Every one also fails the accuracy check
  (no worse than −1 point).
- **Clef-flash comes closest of any challenger in E8 or E8b:** −0.028 nats, 1.7 points less accurate.
- **The ranking holds on Twin.** Clef, clef-flash and the decider win there by about 0.03 nats.

**Tuned Jev against Jev as served** (`full`, T = 4):
- served: +0.008 [−0.021, +0.036], ±0.0 points;
- Twin: −0.000 [−0.007, +0.006], +0.1 points.

Tuned Jev is not better, so nothing changes in production.

## What tuning chose

The chosen configuration is the one picked on everyone. "Folds" counts the people whose own fold, with them left out,
picked the same one.
- **E8** is the setting as E8 ran it.
- **Tuned** is the nested score.
- **In sample** is the chosen configuration scored on everyone, which a naive pick would have claimed.
- **Gain** is tuned − E8, paired.

| Model | Data | Chosen | Folds | Log loss: E8 → tuned (in sample) | Gain | Δ accuracy (points) |
| --- | --- | --- | --- | --- | --- | --- |
| Jev | served | `full+plain`, T by type | 8 of 9 | 1.1730 → 1.1873 (1.1503) | +0.0142 [−0.0113, +0.0415] | +0.1 |
| span-01 | served | `full+text`, T by type | 5 of 9 | 1.2240 → 1.2383 (1.2224) | +0.0143 [+0.0014, +0.0281] | −0.3 |
| clef | served | `derived+choice`, T by type | 5 of 9 | 1.1878 → 1.1856 (1.1703) | −0.0022 [−0.0230, +0.0186] | +0.3 |
| clef-flash | served | `derived`, T by type | 9 of 9 | 1.1843 → 1.1593 (1.1593) | −0.0250 [−0.0494, +0.0004] | +2.0 |
| Perplexity's decider | served | `full+plain`, T by type | 6 of 9 | 1.1746 → 1.1726 (1.1677) | −0.0020 [−0.0132, +0.0090] | +0.7 |
| Jev | Twin | `full+plain`, T by type | 55 of 100 | 0.8143 → 0.8139 (0.8049) | −0.0004 [−0.0063, +0.0055] | +0.2 |
| span-01 | Twin | `context`, T by type | 100 of 100 | 0.8653 → 0.8563 (0.8563) | −0.0090 [−0.0145, −0.0033] | −0.1 |
| clef | Twin | `full+plain`, T by type | 76 of 100 | 0.7814 → 0.7789 (0.7747) | −0.0025 [−0.0069, +0.0020] | +0.1 |
| clef-flash | Twin | `full+text`, T by type | 81 of 100 | 0.7930 → 0.7850 (0.7829) | −0.0080 [−0.0172, +0.0010] | +0.5 |
| Perplexity's decider | Twin | `full`, T by type | 99 of 100 | 0.7890 → 0.7868 (0.7866) | −0.0022 [−0.0048, +0.0005] | −0.1 |

**Every setting, served** (log loss at one leave-one-person-out temperature; the best per model in bold)

| Setting | Jev | span-01 | clef | clef-flash | Decider |
| --- | --- | --- | --- | --- | --- |
| `full` (E8) | 1.1730 | **1.2240** | 1.1878 | 1.1843 | 1.1746 |
| `context` (E8) | 1.1912 | 1.2380 | 1.1795 | 1.1835 | 1.1917 |
| `answers` | 1.1788 | 1.2312 | 1.1830 | 1.1805 | 1.1789 |
| `derived` | 1.1726 | 1.2296 | 1.1797 | **1.1709** | 1.1880 |
| `full+choice` | 1.1693 | 1.2242 | 1.1854 | 1.1873 | 1.1785 |
| `context+choice` | 1.1951 | 1.2385 | **1.1729** | 1.1846 | 1.1960 |
| `answers+choice` | 1.1671 | 1.2313 | 1.1802 | 1.1811 | 1.1839 |
| `derived+choice` | 1.1670 | 1.2286 | 1.1751 | 1.1712 | 1.1917 |
| `full+text` | 1.1729 | 1.2263 | 1.1854 | 1.1768 | 1.1820 |
| `full+plain` | **1.1618** | 1.2319 | 1.1858 | 1.1814 | **1.1744** |

**Every setting, Twin** (on Twin `answers` is `full` and `derived` is `context`)

| Setting | Jev | span-01 | clef | clef-flash | Decider |
| --- | --- | --- | --- | --- | --- |
| `full` (E8) | 0.8143 | 0.8653 | 0.7814 | 0.7930 | **0.7890** |
| `context` (E8) | 0.8273 | **0.8642** | 0.8036 | 0.8024 | 0.8312 |
| `full+choice` | **0.8070** | 0.8649 | 0.7792 | 0.7934 | 0.7935 |
| `context+choice` | 0.8258 | 0.8649 | 0.8015 | 0.8027 | 0.8351 |
| `full+text` | 0.8075 | 0.8648 | **0.7759** | **0.7845** | 0.7876 |
| `full+plain` | 0.8097 | 0.8654 | 0.7773 | 0.7895 | 0.7917 |

## What it shows

1. **At its best, no challenger beats Jev on real users.** E8's verdict survives tuning on both counts. On served
   questions the gaps shrink (clef-flash from +0.011 to −0.028, the decider from +0.002 to −0.015), but no interval
   clears 0 and every challenger still loses accuracy. On Twin, tuning moves no gap by more than 0.009. Clef-flash on
   `derived` would have needed about 0.005 more nats to clear 0 on served questions, and 0.7 more points of
   accuracy.

2. **On nine people, tuning costs more than it finds.** The nested score is the honest one, and it is worse than E8
   for Jev (+0.014) and for span-01 (+0.014, an interval above 0).
   - Jev's in-sample pick (`full+plain`, a temperature per type) promised 1.150. The nested score is 1.187.
   - Eight of nine folds chose the same configuration, and the nested and in-sample scores agree for those eight
     people by construction. So the whole 0.037-nat gap, 17 nats in total, is the one person whose fold chose
     differently. One person's effect on Jev's tuned score is larger than any model gap in this table.
   - On Twin's 100 people the optimism is at most 0.009 and every gain at most 0.009 nats. Jev's own choice is
     unstable there: 55 of 100 folds agree, because `full+choice`, `full+text` and `full+plain` lie within 0.003.

3. **Clef-flash reads what Mimic derives better than what people said.**
   - Clef-flash's served choice is the only stable one that gains: all nine folds chose `derived` (traits and insights,
     no raw answers), for −0.025 nats and +2.0 points.
   - Clef's best served settings also avoid raw answers (`context+choice`, `derived+choice`).
   - Jev and the decider do best on the full state.
   - This extends E8's finding that a better prior is not a better reader: on served questions the clef models do
     best without the raw answers. Twin can't test `derived`, since its people have no traits or insights.

4. **Format matters little.**
   - The best format (scales as choices, the state as text, plain wording) beats E8's request by at most 0.011 nats
     for any model. That is Jev's plain wording on served questions.
   - Asking scales as choices helps Jev on Twin (−0.007), as ADR-0066 found on policy items.
   - The decider and span-01 move by at most 0.002 with format.
   - Every model chose a temperature per question type. That suits a mix in which yes/no, choice and scale questions
     are miscalibrated differently.

5. **Jev isn't repeatable on the same requests.**
   - E8's served tables asked the same 462 questions from the same sealed states as the first run.
   - Every challenger's log loss, and Jev's from the context alone, repeated to three decimals (span-01 1.224,
     clef 1.188, clef-flash 1.184, the decider 1.175; Jev's `context` 1.191).
   - Jev's full-state answers did not: its log loss moved from 1.166 to 1.173, raw from 1.769 to 1.803, and accuracy
     from 58.0% to 57.3%.
   - On served questions, Jev's differences below about 0.01 nats are therefore within its own noise. That covers its
     tuning gains and the decider's E8 gap.

6. **The latency check is noisier than the models' gaps in it.**
   - Jev's p95 was 277 ms in E8's first run, 534 ms in this run's E8 arm, and 297 ms in its tuned arm. The last two
     ran in the same job, within 34 minutes.
   - The decider passed the check against the first and failed against the second, with the same p95 (626 ms).
   - The verdict doesn't depend on it, since every challenger fails on quality first.
   - Changing a gate after seeing the data is the bias E8b avoids, so the fix waits for the next pre-registration
     (`docs/MODELS.md` §9): read each model's latency over all its arms in the run (ten settings, over 5,000
     requests), not only the chosen one.

7. **Costs repeat E8.**
   - On Twin's 20-question batches the decider costs 8.6× Jev per prediction ($0.122 against $0.014 per 1k). That
     fits E8's inference that it counts the state once per question.
   - Clef's p95 on those batches is 11.5 s.
   - Clef-flash costs the same as Jev per request ($0.000223 against $0.000219).

## What it means

- **Jev stays the primary, as served** (`full`, T = 4). No shadow config and no backfill follow from E8b: no tuned
  challenger is `better`, and tuned Jev is not better than Jev as served.
- **Clef-flash on `derived` is now the challenger to watch.** It is the closest on served questions, its choice is
  stable, and it costs what Jev costs. Against it: 1.7 points of accuracy, and 2.7× Jev's median latency.
- **Don't tune on nine people.** Re-run E8b, with GLiDE named (ADR-0070), when E7's probes have at least doubled the
  served people. Free-text prompt search per model stays out until then (`docs/MODELS.md` §9).
- **Pool latency next time.** Pre-register the change from finding 6 before the next run.

## What it can't show

- **The served people aren't fresh.** They are E8's nine people, and the grid's `context` view was suggested by them.
  Nested selection keeps each person out of their own choice, not out of the grid's design. The fresh Twin people
  check the grid's design, not the served verdict.
- **Nine people make the served folds noisy.** Three of the five served choices were backed by only five or six of the
  nine folds.
- **Jev's noise.** One run per setting. Jev's served differences below about 0.01 can't be told from a re-ask.
- **Latency from a GitHub runner.** It varies by a factor of two within a run.
- **No snapshots.** Clef and the decider can change under the same name. These numbers hold for 2026-10-02.
- **Costs at list rate.** Workers AI and Perplexity return tokens, not cost (ADR-0068).
