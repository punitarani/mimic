# M12: the question loop against the rubric under cfg.default.v8 (ADR-0044)

Scripted sessions, not research results. Answers come from a fixed per-prompt policy (`policy: consistent`), so
nothing here says anything about prediction accuracy or about real people. What it measures is the questions the
pipeline served: which categories, facet groups and sensitive facets they reached, when, and whether they were concrete.
Rows are produced by `pnpm eval -- rubric --data <file>`.

## Offline mechanism (fakes; `packages/eval/test/balance.test.ts` runs the same mechanism)

Four people per config, every category and every sensitive area consented, 32 turns; then two people with psychology
off. The fake generator tags whatever it is asked to target and its information term is near zero, so this shows the
mechanism working when nothing competes with it.

| Config | Shares within 15–40% | Psychology / values / life / work (mean) | Groups by 20 | Consented sensitive by 30 | Sensitive in first 5 |
| --- | --- | --- | --- | --- | --- |
| M10 candidate (v4 `voi`) | 0/4 | 50% / 11% / 29% / 11% | 32/40 | 20/44 | 0 |
| v8 | 4/4 | 31% / 23% / 25% / 21% | 40/40 | 44/44 | 0 |
| M10 candidate, psychology off | — | — / 22% / 54% / 24% | 13/14 | 20/22 | 1 person, 1 question |
| v8, psychology off | — | — / 33% / 41% / 26% | 14/14 | 22/22 | 0 |

## Live scripted sessions

`pnpm eval -- session --live --config default --turns 32 --script packages/eval/scripts/m12/<script>.json`, three
scripts: a nurse with every category and every sensitive area; a teacher with every category, politics and health; an
accountant without "Work and money", with religion and sexuality. Live gen.v3 (DeepSeek V4.1 Flash), gates.v3 and the
primary (Jev); about $0.14 a session.

| Run | Build | Shares within 15–40% | Groups by 20 | Consented sensitive by 30 | Sensitive in first 5 | Generated questions concrete (gate) |
| --- | --- | --- | --- | --- | --- | --- |
| a | Balance, ramp and sweep, no deadlines | 2/2 | 25/28 (each person missed one) | 16/20 | 0 (first at 11, 12, 17) | 59/59 |
| b | With coverage deadlines (pre-review) | 2/2 | 28/28 | 20/20 | 0 (first at 11, 11, 11) | 47/47 |
| c | Final `cfg.default.v8` | running | running | running | running | running |

Per person, run b: nurse psychology 29%, values 25%, life 25%, work 21%, 11/11 sensitive; teacher 36%, 18%, 29%, 18%,
5/5; accountant (three categories) 39%, 32%, 29%, 4/4. Run a missed spirituality and substance use for the nurse
(pooled only after the session's last question), substance use for the teacher (asked at 32) and sociosexuality for
the accountant (pooled but outscored by hypothesis information), which is what the deadlines fix.

**Concreteness by hand (run b).** All 47 generated questions describe one specific situation with actions as options;
one (the teacher's handball question) has Yes/No options without saying what yes means. Of 14 reserve items, 12 are
situations and 2 consented sensitive items ask directly by design ("which kind of party would you most likely vote
for", "could you enjoy sex without a relationship").

**Replay.** `replay --mode online` on each run-b session: 30 of 30 states hash-matched per session, pass.
