# jev-predict.v1 — Jev prediction templates (incumbent)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `decision` (use as `decision:<model>`, the incumbent)
- Source: PLAN §9.6
- Harness: `{"reasoningEffort":"low","reasoningMaxTokens":null,"maxTokens":3000,"schema":"probs","jevState":"json","calibrationTemperature":1,"keyEnum":false,"labelKeys":false}`

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
