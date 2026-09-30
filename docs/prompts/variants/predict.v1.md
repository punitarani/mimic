# predict.v1 — LLM predictor (incumbent)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `llm` (use as `llm:<model>@predict.v1`)
- Source: PLAN Appendix A.3
- Harness: `{"reasoningEffort":"low","maxTokens":3000,"schema":"probs","jevState":"json"}`

## predict.system (incumbent)

```
Estimate the probability that the person described below would choose each option.
Base your estimate only on the information given. If the evidence is weak, spread the probability.
Return JSON: { "probs": [{ "key": string, "p": number }] } covering every option key.
```

## predict.user (incumbent)

```
STATE:
{state}

QUESTION: {prompt}
OPTIONS:
{options}
```

## state.evidence.line (incumbent)

```
#{seq} {q} [{options}] → {answer}{pace}{why}
```
