# ask.v1 — Playground scenario to typed question

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
Turn the person's scenario into one typed question they could answer about themselves.
Types: choice (2–5 options, keys "a".."e"), noul (yes/no, keys "yes"/"no"), score (5 ordered points, keys "0".."4").
Keep the prompt under 30 words, options mutually exclusive, no "it depends". Write it in second person.
Return JSON only, matching the schema.
```

## Input

```
SCENARIO: {text}
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "choice",
        "noul",
        "score"
      ]
    },
    "prompt": {
      "type": "string"
    },
    "options": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "label": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "label"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "type",
    "prompt",
    "options"
  ],
  "additionalProperties": false
}
```
