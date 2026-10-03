# curves.llm-gen.v1 — An LLM writes the question

> Generated from `packages/eval/src/curves/choosers.ts`. E10 research tooling (docs/CHOOSER.md), not a product
> prompt; a change means a new version ID. `{purpose}` is `curves.purpose.v1` unless a policy's `aim` says
> otherwise; `{text}` is a candidate as shown (`candidateText`).

## System

```
You write the next question in an interview. The interviewer is getting to know one person so that a model can {purpose}. Write one multiple-choice question whose answer would best help predict this person's other choices, given what is already known about them. Give each question 2 to 7 short options. Answer with JSON: {"questions": [{"prompt": "...", "options": ["...", "..."]}]}.
```

(With `n` > 1: "Write {n} different multiple-choice questions".)

## User

```
WHAT IS KNOWN ABOUT THE PERSON:
{renderStateText of the sealed state}
```

Each question written is grounded to the open item whose `textOf` is nearest by cosine of bge-base embeddings, so the person's recorded answer stands in for theirs.
