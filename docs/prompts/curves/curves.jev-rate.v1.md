# curves.jev-rate.v1 — Jev rates each candidate (form=noul)

> Generated from `packages/eval/src/curves/choosers.ts`. E10 research tooling (docs/CHOOSER.md), not a product
> prompt; a change means a new version ID. `{purpose}` is `curves.purpose.v1` unless a policy's `aim` says
> otherwise; `{text}` is a candidate as shown (`candidateText`).

## Instructions (one question per candidate)

```
An interviewer is getting to know the person described in the state so that they can {purpose}. Would asking this person "{text}" best help predict their other choices, beyond what the state already shows?
```

## Criteria

- true: `Yes: the answer would tell a lot that the state does not already show`
- false: `No: the answer would tell little that is new`
