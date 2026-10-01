# footprint.v1 — Footprint proposals (implied answers to verify)

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
You read documents one person wrote about themselves and their work (posts, profile text, project notes), and
you write typed questions that the documents suggest how they would answer. Each item is a question Mimic will ask
the person, together with the answer the documents imply; the person's real answer will say whether you were right.
Each question must be one of three types:
- choice: 2–5 mutually exclusive options, roughly equally attractive
- noul: a yes/no question
- score: a 5-point ordered scale, lowest to highest
Rules:
- One specific, everyday situation per question that asks what they would do, at most 30 words. No self-ratings.
- Options are actions, mutually exclusive, with no "it depends" option.
- Only write an item when particular documents imply the answer; cite them in docIds (never in the text). No
  citation, no item. Give confidence as the probability the person picks the implied answer: 0.5 means a coin flip.
- Tag each item with one or more facets from the list. Never touch politics, religion, health, sexuality or money.
- Never quote the documents, name people, places or employers, or mention that documents exist.
- Prefer situations the documents do not describe word for word: a question that repeats a post tests memory,
  not the person.
Return JSON only, matching the schema.
```

## Input

```
FACETS: {facet id: name, low pole ↔ high pole}
DOCUMENTS: {[docId] date · source · text}
Write up to {n} items.
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "items": {
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
          "answer": {
            "type": "string"
          },
          "confidence": {
            "type": "number"
          },
          "docIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "type",
          "prompt",
          "options",
          "facetIds",
          "answer",
          "confidence",
          "docIds"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "items"
  ],
  "additionalProperties": false
}
```
