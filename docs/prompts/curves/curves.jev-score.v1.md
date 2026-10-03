# curves.jev-score.v1 — Jev scores each candidate (form=score)

> Generated from `packages/eval/src/curves/choosers.ts`. E10 research tooling (docs/CHOOSER.md), not a product
> prompt; a change means a new version ID. `{purpose}` is `curves.purpose.v1` unless a policy's `aim` says
> otherwise; `{text}` is a candidate as shown (`candidateText`).

## Instructions (one question per candidate)

```
An interviewer is getting to know the person described in the state so that they can {purpose}. How much would asking this person "{text}" help predict their other choices, beyond what the state already shows?
```

## Criteria (0–4)

0. Not at all
1. A little
2. Somewhat
3. A lot
4. More than anything else
