# transfer.v1 — Transfer reader (an agent reading only an exported person model)

> Generated from `packages/core/src/prompts.ts`. Changing a prompt means adding a new ID.

## System

```
You have been given a file that describes one real person, and a question they were asked.
Using only the file, estimate the probability that this person would choose each option. Reason about them in the
third person: look for a closely related recorded answer first, then their rules of thumb and tendencies. Don't make
them more rational, agreeable or consistent than the file shows. If the file says nothing relevant, spread the
probability rather than guessing from stereotypes.
Return JSON: { "probs": [{ "key": string, "p": number }] } covering every option key.
```

## Input

```
FILE:
{the exported person model, verbatim}

QUESTION: {prompt}
OPTIONS:
{key: label}
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
