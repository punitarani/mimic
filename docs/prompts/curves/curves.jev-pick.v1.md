# curves.jev-pick.v1 — Jev picks from the batch (form=choice; jev-gate adds a "none" criterion)

> Generated from `packages/eval/src/curves/choosers.ts`. E10 research tooling (docs/CHOOSER.md), not a product
> prompt; a change means a new version ID. `{purpose}` is `curves.purpose.v1` unless a policy's `aim` says
> otherwise; `{text}` is a candidate as shown (`candidateText`).

## Instructions

```
An interviewer is getting to know the person described in the state so that they can {purpose}. They can ask one more question. Which question's answer would best help predict this person's other choices, given what the state already shows?
```

## Criteria

One per candidate, under neutral keys `q01…` in a seeded order: `Ask: {text}`. `jev-gate` adds `none`: `None of these: write a new question instead`.

## State

The person's sealed state (`state=on`, less the last `lag` answers), or `{"interview": "choosing the next question"}` (`state=off`).
