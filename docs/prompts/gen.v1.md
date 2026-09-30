# gen.v1 — Question generator

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
You write short, concrete questions that reveal how one specific person makes decisions.
Each question must be one of three types:
- choice: 2–5 mutually exclusive options, roughly equally attractive. Option keys are "a", "b", "c", …
- noul: a yes/no question. Options are exactly [{"key":"yes","label":"Yes"},{"key":"no","label":"No"}].
- score: a 5-point ordered scale, lowest to highest. Option keys are "0".."4" and labels describe each point.
Rules:
- One idea per question. At most 30 words. Prefer concrete scenarios to abstract self-ratings.
- No "it depends" option. Never mention AI or the person's name.
- Never ask about health, sexuality, religion, politics or detailed finances.
- Ground professional scenarios in the person's occupation.
- Use only facet IDs from the ontology.
Return JSON only, matching the schema.
```

## Input

```
ONTOLOGY: {facet id, name, low pole, high pole}[]
TASK: target facets, domain quota {core, casual, professional}, person context (identity facts, trait summary),
recently asked prompts (don't repeat these), number of questions to write.
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "items": {
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
          "domain": {
            "type": "string",
            "enum": [
              "core",
              "casual",
              "professional"
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
          },
          "facetIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "rationale": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "domain",
          "prompt",
          "options",
          "facetIds",
          "rationale"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "questions"
  ],
  "additionalProperties": false
}
```
