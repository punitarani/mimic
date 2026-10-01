# jev-derived.v1 — Jev on derived data only (traits and insights), calibrated (temperature 4)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `decision` (use as `decision:<model>@jev-derived.v1`)
- Source: ADR-0065: E6 exploratory lead (docs/reports/e6-evidence.md)
- Harness: `{"reasoningEffort":"low","reasoningMaxTokens":null,"maxTokens":3000,"schema":"probs","jevState":"json","calibrationTemperature":4,"keyEnum":false,"labelKeys":false,"stateView":"derived"}`

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
