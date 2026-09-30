# hyp.v1 — Persona hypotheses (BALD)

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
Write {k} distinct one-paragraph readings of this person. Each must be consistent with every listed answer,
but the readings should differ on the facets with the lowest certainty.
Describe behavior and preferences only; never infer demographics, politics, religion or health.
Return JSON only, matching the schema.
```

## Input

```
STATE: {rendered PersonState}
LOW-CERTAINTY FACETS: {facets}
K: {k}
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "hypotheses": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "text": {
            "type": "string"
          },
          "leanings": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "facetId": {
                  "type": "string"
                },
                "level": {
                  "type": "string",
                  "enum": [
                    "low",
                    "mid",
                    "high"
                  ]
                }
              },
              "required": [
                "facetId",
                "level"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "id",
          "text",
          "leanings"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "hypotheses"
  ],
  "additionalProperties": false
}
```
