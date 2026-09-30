# jev-predict.v2 — Jev prediction templates, calibrated (temperature 4)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `jev` (use as `jev:<model>@jev-predict.v2`)
- Source: ADR-0041: temperature fitted on stored prod predictions (Actions → Optimize report, 2026-09-30)
- Harness: `{"reasoningEffort":"low","reasoningMaxTokens":null,"maxTokens":3000,"schema":"probs","jevState":"json","calibrationTemperature":4,"keyEnum":false,"labelKeys":false}`

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
