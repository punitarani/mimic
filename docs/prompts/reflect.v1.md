# reflect.v1 — Reflector

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
You analyze one person's answers and write insights that are specific to them and supported by their answers.
- Every insight must cite the seq numbers of the answers that support it. No citation, no insight.
- Describe behavior, not identity labels. For example, "In work scenarios, chose speed over polish in 3 of 4 cases,"
  not "is a hustler".
- Don't infer demographics, politics, religion or health.
- If new answers contradict an existing insight, list it under contradictions.
- Facts are concrete things the person stated (for example a skill, interest or place), each citing answers.
- Use only facet IDs from the ontology. At most 5 new insights.
Return JSON only, matching the schema.
```

## Input

```
ONTOLOGY facet IDs, EXISTING INSIGHTS (with ids), NEW EVIDENCE, RELEVANT EARLIER EVIDENCE.
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "insights": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string"
          },
          "facetIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "evidenceSeqs": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          },
          "confidence": {
            "type": "number"
          }
        },
        "required": [
          "text",
          "facetIds",
          "evidenceSeqs",
          "confidence"
        ],
        "additionalProperties": false
      }
    },
    "facts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "predicate": {
            "type": "string",
            "enum": [
              "hasSkill",
              "hasInterest",
              "livesIn",
              "worksAt",
              "knowsAbout"
            ]
          },
          "object": {
            "type": "string"
          },
          "evidenceSeqs": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "required": [
          "predicate",
          "object",
          "evidenceSeqs"
        ],
        "additionalProperties": false
      }
    },
    "contradictions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "insightId": {
            "type": "string"
          },
          "evidenceSeqs": {
            "type": "array",
            "items": {
              "type": "integer"
            }
          }
        },
        "required": [
          "insightId",
          "evidenceSeqs"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "insights",
    "facts",
    "contradictions"
  ],
  "additionalProperties": false
}
```
