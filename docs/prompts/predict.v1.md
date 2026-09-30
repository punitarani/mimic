# predict.v1 — LLM predictor

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
Estimate the probability that the person described below would choose each option.
Base your estimate only on the information given. If the evidence is weak, spread the probability.
Return JSON: { "probs": [{ "key": string, "p": number }] } covering every option key.
```

## Input

```
STATE: {rendered PersonState}
QUESTION: {prompt}
OPTIONS: {key: label}
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "probs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "p": {
            "type": "number"
          }
        },
        "required": [
          "key",
          "p"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "probs"
  ],
  "additionalProperties": false
}
```
