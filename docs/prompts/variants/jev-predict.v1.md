# jev-predict.v1 — Jev prediction templates (incumbent)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0027).

- Predictor kind: `jev` (use as `jev:<model>@jev-predict.v1`)
- Source: PLAN §9.6
- Harness: `{"reasoningEffort":"low","maxTokens":3000,"schema":"probs","jevState":"json"}`

## state.evidence.line (incumbent)

```
#{seq} {q} [{options}] → {answer}{why}
```

## jev.instructions (incumbent)

```
Predict how the person described in the state would answer this question, based only on the state: "{prompt}"
```

## jev.choice (incumbent)

```
The person would choose: {label}
```

## jev.noul.true (incumbent)

```
The person would answer yes
```

## jev.noul.false (incumbent)

```
The person would answer no
```
