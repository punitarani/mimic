# jev-scales.v1 — Jev with scale questions asked as choices, calibrated (temperature 4)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `decision` (use as `decision:<model>@jev-scales.v1`)
- Source: ADR-0066: Twin-2K-500 benchmark, scales as choices
- Harness: `{"reasoningEffort":"low","reasoningMaxTokens":null,"maxTokens":3000,"schema":"probs","jevState":"json","calibrationTemperature":4,"keyEnum":false,"labelKeys":false,"scoreAs":"choice"}`

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
