# predict.v1-direct — LLM predictor, reasoning off (for models that ignore low effort)

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `llm` (use as `llm:<model>@predict.v1-direct`)
- Source: ADR-0038: Qwen3.8 Flash reasons 1-4.5K tokens at effort low; off, it answers in about 2 s
- Harness: `{"reasoningEffort":"none","maxTokens":3000,"schema":"probs","jevState":"json"}`

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
