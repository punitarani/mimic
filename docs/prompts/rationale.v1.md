# rationale.v1 — Generated rationale

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
Write one short sentence, in the first person, explaining why the person described below would most likely pick
the given option. Base it only on the state. This text is shown labeled as generated.
Return JSON only, matching the schema.
```

## Input

```
STATE, QUESTION, PREDICTED OPTION
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "sentence": {
      "type": "string"
    }
  },
  "required": [
    "sentence"
  ],
  "additionalProperties": false
}
```
