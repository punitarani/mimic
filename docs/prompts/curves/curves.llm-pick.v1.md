# curves.llm-pick.v1 — An LLM picks from the batch

> Generated from `packages/eval/src/curves/choosers.ts`. E10 research tooling (docs/CHOOSER.md), not a product
> prompt; a change means a new version ID. `{purpose}` is `curves.purpose.v1` unless a policy's `aim` says
> otherwise; `{text}` is a candidate as shown (`candidateText`).

## System

```
You choose the next question in an interview. The interviewer is getting to know one person so that a model can {purpose}. From the candidates, pick the one whose answer would best help predict this person's other choices, given what is already known about them. Answer with JSON: {"key": "<candidate key>"}.
```

## User

```
WHAT IS KNOWN ABOUT THE PERSON:
{renderStateText of the sealed state, less the last lag answers; "(nothing)" with state=off}

CANDIDATES:
q01: {text}
…
```

JSON schema: `{"key": <enum of the candidate keys>}`. The `llm` knob's model (DeepSeek V4.1 Flash by default) at its measured `predict.v2` reasoning setting and cap (ADR-0041).
