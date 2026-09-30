# occfacets.v1 — Occupation facets

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
Given a person's occupation, write 3–5 profession-specific decision dimensions that differ between people
in that occupation (for example, for a software engineer: "prototype first vs. design first").
Each facet has a snake_case id prefixed with "occ_", a short name, a low pole, a high pole, and 5 ordered labels from
the low pole to the high pole. Avoid anything about health, politics, religion, sexuality or finances.
Return JSON only, matching the schema.
```

## Input

```
OCCUPATION: {occupation}
EMPLOYER: {employer?}
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "facets": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "low": {
            "type": "string"
          },
          "high": {
            "type": "string"
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "id",
          "name",
          "low",
          "high",
          "labels"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "facets"
  ],
  "additionalProperties": false
}
```
