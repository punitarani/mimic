# E8 readout: decision models compared (ADR-0068)

The design and the rule were fixed in `docs/MODELS.md` before this run.

## The run

| | |
| --- | --- |
| Workflow | Actions → Decision models, run `36926382050` on `ed08e85`, 2026-10-01 21:13–21:30 UTC |
| Eval run | `01M3WP08Q7MSSY0772PRNCQE27` (in /lab → Eval runs) |
| Served data | The prod export: 9 consented real people, 462 served questions, one per request |
| Twin data | Twin-2K-500: 200 people, 20 held-out wave 4 items each (4,000), at k = 30, in batches of 20 |
| Models | Jev (`typesafe/jev-1.13-20260917`), span-01 (`respan/span-01-20260925`), clef (`@cf/cloudflare/clef`), clef-flash (`@cf/cloudflare/clef-flash`), Perplexity's decider (`pplx-decider-v1-27b`); each from `full` and `context` |
| Spend | $2.00 of the $5 cap. 44,620 predictions; 3 failed, all the decider's on served questions, counted as uniform. |

All five canaries passed. Their recorded requests and responses are now the adapter fixtures
(`packages/adapters/fixtures/README.md`).

## Verdict (MODELS_RULE): keep Jev

| Challenger | Outcome | Operational checks | Recommended |
| --- | --- | --- | --- |
| span-01 | `worse` | fail (latency) | no |
| clef | `level` | fail (latency) | no |
| clef-flash | `level` | fail (latency) | no |
| Perplexity's decider | `level` | fail (latency: p95) | no |

Δ log loss is challenger − Jev after each model's leave-one-person-out temperature, `full` view. Served intervals
resample questions, Twin's resample people (90%).

| Challenger | Served Δ log loss | Twin Δ log loss | Δ item accuracy, served / Twin (points) | p50 / p95 per request (Jev 189 / 277 ms) | $ per request (Jev $0.000231) |
| --- | --- | --- | --- | --- | --- |
| span-01 | +0.058 [+0.028, +0.086] | +0.053 [+0.042, +0.063] | −9.2 / −4.5 | 689 / 1,457 ms | $0.000155 |
| clef | +0.022 [−0.001, +0.044] | −0.033 [−0.041, −0.025] | −3.7 / +4.7 | 1,007 / 5,859 ms | $0.000779 |
| clef-flash | +0.018 [−0.011, +0.048] | −0.014 [−0.024, −0.004] | −4.3 / +2.7 | 692 / 1,144 ms | $0.000292 |
| Perplexity's decider | +0.008 [−0.010, +0.026] | −0.025 [−0.032, −0.019] | −4.2 / +2.1 | 220 / 570 ms | $0.000848 |

No challenger's served interval lies below 0, and every one loses 3.7 points or more of served accuracy, so none can
be `better`. span-01's intervals lie above 0 on both datasets. No error-rate check failed.

## Results

**Served questions (9 people, 462 questions)**

| Model | Log loss | T | Raw log loss | Item accuracy | Top-1 | ECE | Lift over `context` | p50 / p95 | $ per 1k predictions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jev | **1.166** | 5.79 | 1.769 | **58.0%** | **43.3%** | 0.040 | −0.025 | 181 / 246 ms | $0.210 |
| Perplexity's decider | 1.175 | 3.03 | 1.396 | 53.8% | 39.8% | 0.043 | −0.017 | 171 / 285 ms | $0.158 |
| clef-flash | 1.184 | 3.65 | 1.464 | 53.7% | 40.5% | 0.045 | +0.001 | 635 / 955 ms | $0.182 |
| clef | 1.188 | 2.76 | 1.314 | 54.3% | 39.4% | 0.047 | +0.008 | 848 / 3,883 ms | $0.484 |
| span-01 | 1.224 | 2.52 | **1.258** | 48.8% | 35.1% | 0.066 | −0.014 | 540 / 1,343 ms | **$0.084** |

Jev as served (T = 4) scores 1.171 and 58.1%.

**Twin-2K-500 (200 people, 4,000 items, k = 30)**

| Model | Log loss | T | Raw log loss | Item accuracy | Top-1 | ECE | Lift over `context` | p50 / p95 | $ per 1k predictions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clef | **0.775** | 2.10 | **0.831** | **66.8%** | **62.1%** | 0.055 | −0.035 | 1,481 / 9,423 ms | $0.073 |
| Perplexity's decider | 0.782 | 2.10 | 0.850 | 64.3% | 59.6% | 0.047 | **−0.055** | 446 / 692 ms | $0.122 |
| clef-flash | 0.794 | 2.52 | 0.889 | 64.8% | 59.2% | **0.029** | −0.011 | 896 / 1,482 ms | $0.027 |
| Jev | 0.807 | 4.81 | 1.111 | 62.2% | 57.4% | 0.045 | −0.031 | **214 / 313 ms** | **$0.014** |
| span-01 | 0.860 | 3.65 | 0.870 | 57.7% | 49.7% | 0.066 | +0.002 | 812 / 1,956 ms | $0.016 |

Jev as served (T = 4) scores 0.809 and 62.3%. Lift is `full` − `context` log loss for the same model; below 0 means
the answers help.

**What the answers add** (`full` − `context`, same model; 90% intervals, served by question and Twin by person)

| Model | Served | Twin |
| --- | --- | --- |
| Jev | −0.025 [−0.050, +0.000] | −0.031 [−0.040, −0.021] |
| Perplexity's decider | −0.017 [−0.040, +0.005] | −0.055 [−0.067, −0.042] |
| span-01 | −0.014 [−0.024, −0.003] | +0.002 [+0.001, +0.004] |
| clef-flash | +0.001 [−0.020, +0.022] | −0.011 [−0.015, −0.007] |
| clef | +0.008 [−0.013, +0.029] | −0.035 [−0.043, −0.027] |

**By question type** (`full`; item accuracy)

| Data | Type | n | Jev | span-01 | clef | clef-flash | Decider |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Served | choice | 271 | **49.4%** | 35.8% | 45.4% | 45.0% | 43.9% |
| Served | yes/no | 53 | **62.3%** | 54.7% | 50.9% | 50.9% | 52.8% |
| Served | scale | 138 | 73.1% | 72.0% | 73.0% | 71.8% | **73.4%** |
| Twin | choice | 3,353 | 60.8% | 56.5% | **66.4%** | 64.5% | 62.7% |
| Twin | yes/no | 65 | **53.8%** | 46.2% | 52.3% | 46.2% | 50.8% |
| Twin | scale | 582 | 71.2% | 65.6% | 70.9% | 68.6% | **75.2%** |

On served scales the decider also has the lowest log loss (1.549 against Jev's 1.578); on Twin's, 1.354 against
1.468.

## What it shows

1. **The survey ranking does not carry over.** On Twin, clef, the decider and clef-flash all beat Jev with intervals
   clear of 0. On served questions none does, and all three lose about 4 points of accuracy. Twin ranks the models
   clef, decider, clef-flash, Jev, span-01; served questions rank them Jev, decider, clef-flash, clef, span-01. This
   matches `docs/RESEARCH.md` §8: Twin people never stand in for a Mimic result.
2. **Raw probabilities point the wrong way.** Before any temperature, every challenger beats Jev on served questions
   by 0.30 to 0.51 nats and on Twin by 0.22 to 0.28. Jev's raw probabilities are the most overconfident of the five
   (T ≈ 5.8 served, 4.8 Twin; the others 2.1 to 3.6). After one temperature per model the served comparison reverses
   for all four. A comparison of decision models on raw probabilities, or with one model's temperature, is not a
   comparison.
3. **A better prior is not a better reader.** From the context alone, clef has the best served log loss of any model
   (1.180, against Jev's 1.191). Given the person's answers it gets slightly worse (1.188), and so does clef-flash,
   while Jev and the decider improve. On Twin the decider gains the most from answers and span-01 nothing. E6 found
   Jev's served lift within noise on 6 people (−0.024 [−0.065, +0.019] by question). On 9 people its size is the
   same, −0.025: the interval by person now excludes 0, and the one by question still just touches it
   ([−0.050, +0.000]).
4. **Price per token misleads.** The decider lists at $0.04/M, below Jev, and is cheaper than Jev on single
   questions ($0.16 against $0.21 per 1k). On 20-question batches it costs 8.7× Jev per prediction ($0.122 against
   $0.014). Its reported input tokens explain it: about 61,000 per Twin batch, against about 6,100 for clef on the
   same requests (both priced from tokens at list rate). On single questions the ratio is about 2×. A gap that grows
   with the batch suggests Perplexity counts the state once per question. That is an inference from token counts, not
   documented.
5. **Tails differ more than medians.** Jev is the fastest at p95 everywhere. The decider matches it on single questions
   (171 against 181 ms median), but on batches its p95 is more than twice Jev's (692 against 313 ms). Clef's p95
   reaches 9.4 s on Twin's 20-question batches. Every challenger fails the latency check, so none could be recommended
   even had one been `better`.
6. **Each model has its own strength.** Jev's served lead comes from choices and yes/no questions. Scales are level on
   served questions, and on Twin the decider is best on them by 4 points. Clef's Twin gain is almost all
   multiple-choice items. span-01 trails most on choice questions (13.6 points served, 4.3 on Twin), where it answers
   one yes/no per option (ADR-0051).

## What it means

- **Jev stays the primary.** No shadow config and no backfill follow from E8.
- **Perplexity's decider is the challenger to watch.** It is level with Jev on served log loss, the closest of the
  four, and gains from answers on both datasets (on served questions within noise, as Jev's is). It is as fast as Jev
  on single questions. Against it: 4 points of served accuracy, its p95, and its cost on batched requests. Re-run E8
  with it alone
  (`predictors=decision:typesafe/jev-1.13,decision:perplexity/pplx-decider-v1-27b`) once E7's probes have more people,
  or if Perplexity publishes a dated snapshot.
- **Clef and clef-flash know the population better than they read the person.** That suits Twin's survey items and
  not Mimic's next question.
- **span-01 stays behind the `decisions-model` flag's default.** It is worse on both datasets.

## What it can't show

- **Nine served people.** The served interval resamples questions, so a by-person effect could still hide in it.
  Twin's 200 people decide direction, not the served verdict.
- **One prompt.** Every model was asked with Jev's request, and the harness was tuned on Jev. A challenger's best
  prompt is its own optimization run (`docs/OPTIMIZATION.md`).
- **No snapshots.** Clef and the decider can change under the same name; these numbers hold for 2026-10-01.
- **Latency from a GitHub runner.** The three vendors sit at different network distances from it.
- **Costs at list rate.** Workers AI and Perplexity return tokens, not cost (ADR-0068).
