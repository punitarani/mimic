# M10: calibrating gates.v3 (ADR-0042)

Live Jev (`typesafe/jev-1.13`) on hand-labelled questions, 2026-09-30. Labels are the implementer's judgements from
the definitions in `packages/eval/labeled/gates.v3.json`, written before any gate saw the items. Drafts were sampled
with `pnpm eval -- drafts` (raw generator output, before any gate) for a scripted nurse and a scripted accountant;
no real person's data is involved.

```
pnpm eval -- drafts --config m10-candidate --batches 6 --per-batch 10 --out data/drafts.gen-v3.json
pnpm eval -- drafts --config default --batches 3 --per-batch 10 --out data/drafts.gen-v2.json
pnpm eval -- gates --labeled packages/eval/labeled/gates.v3.json --version gates.v3
pnpm eval -- drafts --config m10-candidate --batches 4 --per-batch 10 --occupation Accountant --out data/drafts.gen-v3.heldout.json
pnpm eval -- gates --labeled packages/eval/labeled/gates.v3.heldout.json --version gates.v3
```

## The labelled set

| Source | Items |
| --- | --- |
| gen.v3 | 59 |
| gen.v2 | 20 |
| handwritten | 54 |

Items with the problem each gate looks for (for `quick` and `concrete`, items that are slow or not concrete):

| Gate | Bad | Good |
| --- | --- | --- |
| concrete | 34 | 99 |
| sensitive | 11 | 122 |
| demeaning | 10 | 123 |
| leading | 12 | 121 |
| ambiguous | 6 | 127 |
| quick | 3 | 130 |

## Results

"First wording" is the run with the gates.v2 wording for `sensitive` and `leading`; "gates.v3" is the final wording.
Caught and false alarms are at the chosen threshold on the final run.

| Gate | AUC, first wording | AUC, gates.v3 | Fails when | Caught | False alarms | Best threshold by balanced accuracy |
| --- | --- | --- | --- | --- | --- | --- |
| concrete | 0.990 | 0.990 | p < 0.4 | 33 of 34 | 3 of 99 | 0.39 |
| sensitive | 0.991 | 0.993 | p > 0.3 | 11 of 11 | 3 of 122 | 0.3 |
| demeaning | 0.965 | 0.960 | p > 0.5 | 9 of 10 | 4 of 123 | 0.42 |
| leading | 0.853 | 0.948 | p > 0.4 | 9 of 12 | 4 of 121 | 0.18 |
| ambiguous | 0.776 | 0.780 | p > 0.9 | 1 of 6 | 0 of 127 | 0.81 |
| quick | 0.887 | 0.887 | p < 0.6 | 1 of 3 | 2 of 130 | 0.89 |

Pass rates at the chosen thresholds, counting a draft as good when it has none of the problems:

| Set | Source | Good drafts passed | Flawed drafts rejected |
| --- | --- | --- | --- |
| gates.v3.json | gen.v2 | 19 of 20 | 0 of 0 |
| gates.v3.json | gen.v3 | 54 of 57 | 1 of 2 |
| gates.v3.json | handwritten | 9 of 9 | 45 of 45 |
| gates.v3.heldout.json | gen.v3 (held out, accountant) | 34 of 36 | 1 of 4 |

## What changed after the first run

- **Sensitive.** The gates.v2 question ("Does this question touch on health, …?") rejected 7 of 59 gen.v3 drafts for
  a nurse, all about caring for patients. gates.v3 asks about "the answerer's own" life and says that caring for
  patients or clients at work does not count. AUC 0.991 → 0.993; the nurse drafts now pass.
- **Leading.** The gates.v2 question flagged scenarios where one option is more admirable (returning extra change,
  not cheating at a board game) and missed loaded phrasing. gates.v3 asks whether the wording pushes toward an answer.
  AUC 0.853 → 0.948.
- Thresholds were then chosen on this set, and a fresh held-out sample (a different occupation) was drawn, labelled
  and scored once.

## Misses and false alarms at the chosen thresholds

**concrete**

- missed, p = 0.72 (gen.v3): Your team is assigned a complex task. How do you prefer to work?
- false alarm, p = 0.39 (handwritten): Are you ashamed of how your body looks at the beach?
- false alarm, p = 0.09 (handwritten): How many sexual partners have you had in the past year?
- false alarm, p = 0.05 (handwritten): Think about the ten biggest decisions of your life. How many did you make on gut feeling?

**sensitive**

- false alarm, p = 0.37 (gen.v3): A close friend asks how you're really doing after a hard month. What comes out?
- false alarm, p = 0.43 (handwritten): Would you hide your sexual history from a new partner?
- false alarm, p = 0.94 (handwritten): Most sensible people save something every month. Do you?

**demeaning**

- missed, p = 0.25 (handwritten): How often do you struggle to control your drinking?
- false alarm, p = 0.58 (handwritten): How many sexual partners have you had in the past year?
- false alarm, p = 0.52 (handwritten): You are dating someone new and they want to sleep together on the second date. What do you do?
- false alarm, p = 0.74 (handwritten): Most sensible people save something every month. Do you?
- false alarm, p = 0.66 (handwritten): A friend asks you to help them move on Saturday, which you had planned to rest. Surely you would help a friend?

**leading**

- false alarm, p = 0.62 (gen.v3): You've lived in the same Lisbon neighbourhood for ten years. A friend says you'd love a year abroad.
- false alarm, p = 0.65 (gen.v3): Protocol says get a doctor's approval first, but a patient needs a step now and you're sure it's right.
- false alarm, p = 0.50 (gen.v2): You're offered a visible lead role on a unit project, with longer hours. Take it for the recognition, or stay focused on patient care?
- missed, p = 0.28 (handwritten): How often do you struggle to control your drinking?
- missed, p = 0.19 (handwritten): Would you hide your sexual history from a new partner?
- false alarm, p = 0.56 (handwritten): How much debt do you have?
- missed, p = 0.19 (handwritten): Who is more moral, religious people or atheists?

**ambiguous**

- missed, p = 0.85 (handwritten): How would you describe your attitude to authority?
- missed, p = 0.82 (handwritten): Do you like change?
- missed, p = 0.83 (handwritten): How do you feel about rules?
- missed, p = 0.88 (handwritten): Would you rather be right or be kind, and does your answer differ at work and at home?
- missed, p = 0.78 (handwritten): Do you usually go with the flow?

**quick**

- false alarm, p = 0.47 (handwritten): What made you stop believing in God?
- missed, p = 0.88 (handwritten): Would you rather be right or be kind, and does your answer differ at work and at home?
- false alarm, p = 0.47 (handwritten): Is it better to save or invest?
- missed, p = 0.61 (handwritten): Think about the ten biggest decisions of your life. How many did you make on gut feeling?

## Limits

- One labeller, the implementer. The rare classes (ambiguous, slow, demeaning) are mostly handwritten, so their
  numbers say how the gate treats clear cases, not subtle ones: on the held-out set 3 of 4 mildly flawed drafts passed.
- `ambiguous` barely separates (AUC 0.78). Its threshold rose to 0.9 because every ambiguous item here is abstract and
  `concrete` rejects it; `quick` keeps its gates.v2 threshold because 3 slow items are too few to move it.
- Per-item probabilities: `docs/reports/m10-gates.probabilities.json`.
