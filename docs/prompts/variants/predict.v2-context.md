# predict.v2-context — LLM predictor (predict.v2 settings) on the context alone

> Generated from `packages/core/src/components.ts`. A change means a new version ID (ADR-0028).

- Predictor kind: `llm` (use as `llm:<model>@predict.v2-context`)
- Source: ADR-0065: E6 exploratory lead (docs/reports/e6-evidence.md)
- Harness (every model): `{"schema":"probs","jevState":"json","calibrationTemperature":1,"keyEnum":true,"labelKeys":true,"stateView":"context"}`
- Models: only those listed below.

## Per-model harness

| Model | Reasoning | Token cap (reasoning and answer) |
| --- | --- | --- |
| `openai/gpt-6-luna` | effort low | 1500 |
| `deepseek/deepseek-v4.1-flash` | effort low | 6000 |
| `z-ai/glm-5.3-flash` | effort low | 3000 |
| `xiaomi/mimo-v2.6-flash` | budget 1024 tokens | 2048 |
| `qwen/qwen3.8-flash` | budget 1024 tokens | 2048 |

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
