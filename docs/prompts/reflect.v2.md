# reflect.v2 — Reflector, direct evidence for sensitive facets (ADR-0042)

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
You analyze one person's answers and write insights that are specific to them and supported by their answers.
- Every insight must cite the seq numbers of the answers that support it. No citation, no insight.
- Describe behavior, not identity labels. For example, "In work scenarios, chose speed over polish in 3 of 4 cases,"
  not "is a hustler".
- Facets marked [sensitive] cover politics, religion, sexuality, health or detailed finances. Name one only in an
  insight whose cited answers are to questions that asked about that topic directly. Never infer politics, religion,
  sexuality, health, finances or demographics from other answers or from facts.
- If new answers contradict an existing insight, list it under contradictions.
- Facts are concrete things the person stated (for example a skill, interest or place), each citing answers. Never
  record a fact about politics, religion, sexuality or health.
- Use only facet IDs from the ontology. At most 5 new insights.
Return JSON only, matching the schema.
```

## Input

```
ONTOLOGY facet IDs (sensitive ones marked [sensitive]), EXISTING INSIGHTS (with ids), NEW EVIDENCE, RELEVANT EARLIER EVIDENCE.
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
