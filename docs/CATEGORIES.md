# Categories and consent

What a mimic may be asked about and learn, how a person chooses it, and how that choice is enforced (ADR-0036). The
copy quoted here is the source the intake form and the session sheet render (`CATEGORY_INFO`, `AREA_INFO` and
`SELF_ONLY_NOTE` in `packages/core/src/scope.ts`).

## 1. The four categories

Every facet belongs to exactly one category. All four are selected by default, and a person can deselect any of them,
at intake or later from the session menu. At least one must stay selected.

| Id | Name | Description | Sensitive areas inside it |
| --- | --- | --- | --- |
| `psychology` | Personality and psychology | How you think, feel and decide: habits, emotions, motivation and self-control. | none |
| `values` | Values, beliefs and politics | What you care about and believe: fairness, loyalty and how the world works. | politics, religion |
| `life` | Relationships, sexuality and life | Friends, partners, family and everyday life. | sexuality, health |
| `work` | Work and money | How you work, decide with others, spend and save. | money |

Question domains (`core`, `casual`, `professional`) are a separate axis: they say what kind of scenario a question is
set in, not what it measures. A casual scenario can measure a work facet ("a friend asks you to split a bill") and a
professional one can measure a psychology facet.

### Facets by category (ontology v1)

| Category | Groups | Facets |
| --- | --- | --- |
| Personality and psychology (11) | Personality, Decisions | openness, conscientiousness, extraversion, agreeableness, emotional stability; risk tolerance, patience, loss aversion, ambiguity tolerance, maximizing, deliberation |
| Values, beliefs and politics (4) | Values | openness to change, self-enhancement, conservation, self-transcendence |
| Relationships, sexuality and life (11) | Social, Everyday, Communication | trust, reciprocity, conformity, conflict directness; routine, social energy, taste novelty; directness, formality, verbosity, humor |
| Work and money (7 + occupation facets) | Work, Everyday | autonomy, planning, detail orientation, collaboration, leadership drive, speed vs. quality; spending style |

`spending_style` sits in the Everyday group in v1 but belongs to "Work and money", so a facet keeps one category in
every ontology version (it moves to the Money group in v2). Occupation facets, generated per person from their
occupation, are always "Work and money"; none are generated when that category is deselected.

Ontology v2 (ADR-0037) adds facets to every category and the sensitive facets below; its table is in
`docs/ontology/v2.json` and its research anchors in `docs/ontology/v2.sources.md`.

## 2. Sensitive areas

Five areas are opt-in, each under its own consent, asked for under the category it belongs to. A sensitive area is
reachable only when its category is selected and its consent is given.

| Area | Name | Why we ask (shown with the consent) | Category | Special-category |
| --- | --- | --- | --- | --- |
| `politics` | Political views | Where you stand politically shapes many everyday choices, so asking beats guessing. | values | yes |
| `religion` | Religion and worldview | Faith, or its absence, shapes values and routines; we only learn it if you answer. | values | yes |
| `sexuality` | Sexuality and intimate relationships | How you approach intimacy and commitment shapes many relationship decisions. | life | yes |
| `health` | Health and body | How you look after your health and body affects daily choices about food, rest and risk. | life | yes |
| `money` | Money in detail | Savings, debt and financial security change how people weigh risk and spending. | work | no |

Every sensitive consent is shown with: "Your answers stay yours: they are only used to build your mimic."

Special-category areas are political opinion, religion, sexual orientation and sex life, and health (the GDPR art. 9
categories that apply here). Money in detail is sensitive by our policy but not special-category.

### Rules for sensitive facets

- **Only direct, consented questions populate a sensitive facet.** Nothing about politics, religion, sexuality, health
  or detailed finances is inferred from other answers, from web search or from enrichment. The reflector is told
  so, and code enforces it: an insight may name a sensitive facet only when it cites an answer to a question that
  asked about that facet directly, and a sensitive trait is read only once such an answer exists (ADR-0038).
- **Never from the web.** Identity search and enrichment never ask for special-category fields, and a lexicon drops
  any fact from search or enrichment that reveals one (`specialAreaOfFact` in `packages/core/src/scope.ts`). It errs
  toward dropping; professional facts (an employer, a job title, a school) are kept for health, because working in
  health care says nothing about the person's own health.
- **Respectful wording.** Sensitive questions are asked plainly, never presuming a belief, identity, condition or
  orientation, with options covering the range. The `demeaning` Jev gate rejects loaded or demeaning drafts; the
  `sensitive` gate stays as a backstop against drafts that touch a sensitive topic without being tagged with a
  consented sensitive facet (ADR-0037).
- **Later in the session.** No sensitive question is served among the first five, and none before the person has
  answered a few ordinary ones (the trust ramp, ADR-0039).

## 3. The consent model

Stored on the mimic (`mimics.categories_json`, `consents_json`, `research_consents_json`, `scope_at`; migration
0005) as a `MimicScope`:

```ts
{ categories: Category[];                               // at least one
  consents: { politics?, religion?, sexuality?, health?, money?: true };
  researchConsents: { politics?, religion?, sexuality?, health?: true } }
```

- **Defaults.** Every category, no sensitive area, no special-category research use. Mimics created before ADR-0036
  read as this default, which is exactly what they were asked about.
- **Normalisation** (`normalizeScope`). Categories are kept in canonical order; only `true` flags are stored; a
  consent whose category is deselected is dropped (reselecting the category asks again); a research consent is
  kept only with the area's consent and research consent overall.
- **Changing it later** (`setScope`, from the session menu). The new scope applies to the next question.
  - **Narrowing** (a category deselected or a consent withdrawn) stamps `scope_at`. Every pooled or
    served-but-unanswered question touching a now-blocked facet is discarded and never served. Earlier answers in
    that area, the trait estimates and insights built on them, and reflection facts citing them are hidden from
    every later state, snapshot, view, export and `mimic.json`. The rows stay in the database until the person
    deletes the mimic (hard delete removes everything, as before).
  - **Widening** changes no stored data. The pool fills with the new areas on the next refill.
- **Replay.** Hidden data is never time-travelled back into a rebuilt state: privacy wins over byte-for-byte replay,
  as it does for removed facts (ADR-0017). `replay --mode online` reports states served before `scope_at` as
  `rescoped`, next to `legacy` and `truncated`, and checks hashes on the rest.

## 4. Research exports and special-category data

- Research exports (`pnpm eval -- export`) keep only research-consented mimics, as before (PLAN §3.8).
- For each special-category area a person has not consented to research use of, the export drops: questions
  touching that area's facets with their answers, predictions and scores; trait estimates and history for those
  facets; insights naming those facets or citing those answers; reflection facts citing those answers; knowledge
  graph facet nodes and edges for those facets (ADR-0038).
- Money in detail follows plain research consent.
- Aggregate item statistics (`item_stats`) count rows touching a special-category facet only from people who
  consented to research use of that area.
- `--keep-identity` exports, internal and never shared, keep special-category data because reproducing online
  predictions needs every sealed state's evidence; the CLI warning says so.
- Hard delete covers every table, blob, vector and cache key, special-category data included.

## 5. Where it is enforced

A category the person deselected, or a sensitive area without consent, is unreachable in code, not only in prompts.
The facet list every stage uses comes from one place, `facetsFor`, which is scoped by default.

| Stage | How | Since |
| --- | --- | --- |
| Facet list | `facetsFor(deps, m, cfg)` returns only allowed facets; `{ scoped: false }` only where blocked facets must be known | M9 |
| Loaders and states | `assemble()` hides answers to out-of-scope questions, blocked traits, hidden insights and reflection facts | M9 |
| Anchors | Seeded at intake only if every facet they touch is allowed | M9 |
| Serving | Anchors, repeat sources, the adaptive pool and the reserve bank are filtered by scope | M9 |
| Generator | Targets and the ontology block come from scoped facets; a draft tagging a blocked facet is rejected | M9 |
| Trait reader | Scoped facets only; psychometric anchor scoring only for allowed facets; sensitive traits only with direct evidence | M9 / M11 |
| Reflector | Scoped facet list; insights and facts touching a blocked facet or a hidden answer dropped; sensitive tags need a direct question | M9 / M11 |
| Hypotheses and belief | Scoped facets; hidden answers never count | M9 |
| Occupation facets | Generated only with "Work and money" selected | M9 |
| Gates | `sensitive` backstop and `demeaning` check by consent (gates.v3) | M10 |
| Web search and enrichment | Special-category facts dropped before they are stored | M11 |
| Views and `mimic.json` | Scoped facets, insights, facts and graph nodes only | M9 / M11 |
| Item statistics | Special-category rows only with research consent for the area | M11 |
| Research export | Special-category rows scrubbed without research consent for the area | M11 |
| Scope changes | `setScope` discards out-of-scope pooled and waiting questions; `PATCH /api/mimics/:id/scope` | M9 / M11 |

The leakage tests (`packages/eval/test/scope.test.ts`) prove that no served question, trait read, insight, fact,
graph node, view or export touches a deselected or non-consented category.
