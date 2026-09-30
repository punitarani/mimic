# Mimic — Efficient Human Mimicry

Implementation plan v1 · 2026-09-29

> For Claude Code: read §0 first, then build milestone by milestone (§14). The research invariants in §3 are non-negotiable. If a shortcut would break one, stop and ask.

---

## 0. How to use this document

- `CLAUDE.md` at the repo root has conventions and commands. This file is the product and system spec.
- Milestones in §14 are ordered, and each has acceptance criteria. Don't start a milestone until the previous one's criteria pass.
- Record any deviation from this plan in `docs/DECISIONS.md`, one short ADR per decision.
- Model IDs and prices in §5 were verified on 2026-09-29. Re-check OpenRouter before M1, and never hardcode prices: read cost from each response.

---

## 1. What we're building

Mimic learns a person from a short, adaptive Q&A session and persists a **mimic**: a portable model that predicts how that person would decide. It is also a research platform for comparing cheap ways of doing that.

It has two research axes:

1. **Efficient LLMs.** GPT-6 Luna, DeepSeek V4.1 Flash, and GLM 5.3 Flash write questions, reflect on answers, and serve as baseline predictors.
2. **Decision model.** TypeSafe Jev is the primary predictor and trait reader. The OpenAI Decisions API gets an interface stub only and is out of scope.

### Research questions

- **RQ1 Predictor.** Does Jev beat the three LLMs at predicting a person's answers (log loss, accuracy, calibration), per dollar and per millisecond?
- **RQ2 Question efficiency.** Which selection strategy reaches a target fidelity in the fewest questions?
- **RQ3 Representation.** Do reflection and knowledge-graph structure add fidelity beyond raw Q&A? Do they individuate the person or stereotype them?
- **RQ4 Generator/reflector LLM.** Which of the three LLMs gives the best fidelity per dollar?

### Goals (v1)

- A new person reaches a stable fidelity estimate within about 30 questions (6–8 minutes).
- Time from answer submit to next question is p50 ≤ 800 ms and p95 ≤ 2 s.
- Model spend per mimic averages ≤ $0.25 including shadow predictors, with a hard cap of $0.50.
- Every prediction is reproducible from its config hash, prompt version, model snapshot and state hash.
- The eval CLI can replay consented sessions offline with no code changes.

### Non-goals (v1)

- **Modeling third parties.** You can only build a mimic of yourself. This is for privacy, and it also means people search never runs on anyone else.
- **Free-text-only answers.** Every question is typed. A free-text "why" is optional context and is never scored.
- **OpenAI Decisions API.** Only the `DecisionProvider` interface ships now, so the API can slot in later.
- **Fine-tuning or per-person weights.** Deferred to P2 (§16).
- **Sensitive domains without consent.** Health, sexuality, religion, politics and detailed finances are never asked
  about unless the person opts in to that area. Each is a separate consent under one of four categories the person
  selects at intake, and only direct, consented questions ever populate them (ADR-0040, `docs/CATEGORIES.md`).
- **Voice or multiple languages.**

---

## 2. The core idea

Every question is a **typed decision**: `choice`, `noul` (yes/no) or `score` (an ordered 5-point scale). These are the same three primitives Jev answers natively. Before the person answers, the mimic predicts a probability distribution over the options. The answer first scores that prediction, and only then becomes learning data.

This has four consequences:

- **Fidelity is measured prequentially.** Every turn is scored on data the model hasn't seen yet, so the headline number is an honest held-out estimate rather than the model grading itself.
- **Predictor comparisons are fair.** The same typed question works for Jev and for LLM predictors.
- **There is always a baseline.** A predictor that sees only intake context runs on every question: name, location, occupation and search facts, but no answers. The number that matters is lift over this baseline. Digital-twin research shows demographics-only personas are a strong baseline that rich profiles often barely beat.
- **Repeat probes set the ceiling.** Re-asking questions measures how consistent the person is with themselves, which caps achievable accuracy. The headline is accuracy divided by self-consistency: "predicts you X% as well as you predict yourself".

```
Intake ─► Identity (search → "Is one of these you?" → facts) ─► Anchor battery (10 fixed items)
   └─► repeat:  select question ─► seal predictions ─► person answers ─► score ─► learn (async)
                                                                             └─► snapshot mimic
```

---

## 3. Research invariants (non-negotiable)

1. **Sealed predictions.** The prediction for question *t* is built from a state containing only answers with seq < *t*. Store `stateHash` and `evidenceSeqMax` with it. No state used to predict *t* may ever include answer *t*. Sealing is defined by what the state contains, not by timestamps, so shadow predictors may finish after the answer arrives.
2. **Primary before display.** The primary (Jev) and baseline predictions are persisted before the question is returned to the client.
3. **Raw evidence is the source of truth.** Traits, insights, the KG and snapshots are derived and versioned, and can be recomputed from evidence plus config.
4. **Everything versioned.** Every question, prediction, trait estimate and insight carries `configHash`, `promptVersion`, and the model snapshot ID returned by the provider.
5. **Every model call logged.** Each call writes a `model_calls` row with purpose, model, tokens, cost, latency, ok/error and config hash, plus a full trace in R2.
6. **Baseline always on.** Every scored question gets a context-only prediction.
7. **Anchors and repeats.** Everyone gets 10 anchor items, plus about 1 repeat probe per 8 adaptive questions.
8. **Consent gates research use.** Only mimics with `consent_research = true` enter eval exports. Each mimic's dev/test split is set by `hash(mimicId)` and never changes.
9. **No cross-person leakage.** Other people's data never enters a prompt or state, except for experiment-flagged population priors (§12.6).
10. **Keys stay server-side.** No model or search call is made from the browser.

---

## 4. Glossary

| Term | Meaning |
|---|---|
| Mimic | The persistent learned model of one person: evidence, derived state and config. |
| Evidence | One answered question, with its optional "why". |
| Facet | One ontology dimension, such as risk tolerance (Appendix C). |
| Predictor | Anything that maps (state, question) to a distribution over options. |
| Primary | The predictor behind the UI and headline (Jev by default). |
| Shadow | A predictor that runs for comparison only. |
| Baseline | The primary predictor on a context-only state (no answers). |
| Question kinds | `anchor`, `adaptive`, `repeat`, `playground`, `feedback` (ADR-0032). |
| Fidelity | The headline metric (§9.10). |

---

## 5. Models and providers (verified 2026-09-29)

| Role | Model / service | Notes |
|---|---|---|
| LLM | `openai/gpt-6-luna` | $0.10 in / $0.50 out per M tokens; cached input $0.01/M; 1.05M context. Provider listings mark `temperature` as unsupported, so don't send it; use `reasoning.effort` instead. |
| LLM | `deepseek/deepseek-v4.1-flash` | About $0.15–0.30 in / $0.60–1.20 out per M, depending on the provider OpenRouter routes to; 1M context; structured outputs. |
| LLM | `z-ai/glm-5.3-flash` | About $0.075–0.09 in / $0.25–0.30 out per M; 1M context; structured outputs. |
| Decision | `typesafe/jev-1.13` (pinned) | `POST https://openrouter.ai/api/alpha/decisions`. $0.042/M input, output free; 32K context; answers in 70–500 ms. |
| Decision | OpenAI Decisions API | Out of scope; `DecisionProvider` stub only. |
| Search | Exa, `category: "people"` | Candidate discovery for identity resolution. |
| Search | Exa `/contents` (person entity; schema summary for other pages), Parallel Task API optional | Structured enrichment of the confirmed identity (ADR-0034). |
| Search | Perplexity | Optional fallback adapter. |
| Embeddings | A Workers AI embedding model | For question dedupe and evidence retrieval (Vectorize). Pick the model at M1 and record its ID in config. |

Rules:

- **Read cost from responses.** Use `usage.cost` from both chat and decisions responses. Never compute cost from hardcoded prices.
- **Pin Jev.** Use `typesafe/jev-1.13` in experiments, not `~typesafe/jev-latest`, because probabilities can shift between versions. Store the dated snapshot the response returns, such as `typesafe/jev-1.13-20260917`.
- **Require structured-output support.** For JSON-schema chat calls, use OpenRouter provider routing that requires it (`provider: { require_parameters: true }`).
- **Order prompts for caching.** Put stable content first (system, ontology, instructions) and variable content last.

### 5.1 Jev contract (what the adapter implements)

Request:

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "...": "any JSON object; our PersonState (§9.9)" },
  "questions": {
    "q_abc": { "type": "choice", "instructions": "...", "criteria": { "a": "...", "b": "..." } },
    "q_def": { "type": "noul",   "instructions": "...", "criteria": { "true": "...", "false": "..." } },
    "q_ghi": { "type": "score",  "instructions": "...", "criteria": ["lowest", "...", "highest"] }
  }
}
```

Response `answers`, per question key:

| Type | Shape |
|---|---|
| `noul` | `{ "noul": p_yes }` |
| `choice` | `{ "choice", "confidence", "probabilities": { key: p } }` |
| `score` | `{ "score": expectedIndex, "confidence", "probabilities": { "0": p, ... }, "legend" }` |

Response metadata: `model` (the dated snapshot) and `usage: { input_tokens, output_tokens, cost }`.

Facts that shape the design:

- **Batch by shared state.** All questions in one request share one state and are answered independently and in parallel. Put every question that shares a state into one request.
- **No reasoning text.** Jev can't explain itself. Any explanation comes from an LLM and is labeled as generated.
- **32K context.** The state builder must enforce a token budget (§9.9).
- **It is a beta on an `alpha` path.** Isolate it behind `DecisionProvider`, validate responses with zod, tolerate schema drift, and keep recorded fixtures.

Mapping to our `Distribution` (§7):

- `noul` → `{ yes: p, no: 1 − p }`. Our noul option keys are `yes`/`no`; they map to Jev's `true`/`false` criteria keys.
- `choice` → probabilities keyed by option key
- `score` → probabilities keyed by index `"0"`–`"4"`

---

## 6. Architecture

### 6.1 Stack

- **Hosting.** Cloudflare Workers, with Next.js running via `@opennextjs/cloudflare`.
- **Tooling.** Turborepo with pnpm; TypeScript in strict mode.
- **Storage.** D1 (Drizzle ORM) for relational data; R2 for blobs (traces, raw search results, snapshots, eval reports); KV for caches; Vectorize for Q&A and fact embeddings.
- **Platform.** Queues for async jobs; Workers AI for embeddings; the Workers Rate Limiting binding.
- **Client.** zod at every boundary; TanStack Query with an IndexedDB persister.

**Why D1 and not Postgres.** Per-mimic data is small, and every hot query is scoped to one mimic. The KG is a two-table property graph. Cross-person analytics run offline in the eval CLI on an export (SQLite or DuckDB). Revisit Postgres only if we need server-side cross-person SQL at scale or hit D1 size limits.

### 6.2 Repo layout

```
mimic/
  apps/
    web/          Next.js (OpenNext): UI and route handlers for the synchronous path
    worker/       Queue consumer (async jobs) and cron; same bindings as web
  packages/
    core/         Pure TS engine: types, ontology, strategies, scoring, fidelity. No Cloudflare, Next or Node imports.
    adapters/     OpenRouter chat, Jev decisions, OpenAI-decisions stub, Exa/Parallel/Perplexity, embeddings
    db/           Drizzle schema, migrations, repositories, R2/KV/Vectorize helpers
    eval/         Node CLI: export, replay, selection simulation, dataset importers, reports
  docs/
    PLAN.md  DECISIONS.md  ontology/  prompts/
```

`packages/core` receives its dependencies (predictors, LLM client, repositories) by injection. That way the same code runs in `web`, in `worker`, and in the Node eval CLI.

### 6.3 Runtime

```
Browser ──HTTPS──► apps/web (Next route handlers) ──► D1 / KV / R2 / Vectorize
   ▲  IndexedDB (cache + outbox)          │ enqueue
   │                                      ▼
   └──── poll/refetch ◄──── apps/worker (Queue consumer) ──► OpenRouter (LLMs, Jev), Exa, Parallel
```

### 6.4 Sync vs async

Synchronous calls, where the user waits:

- **`POST /next`** picks from a pre-generated pool. It scores all pooled candidates with one batched Jev call on the current state, and that call's output for the chosen question is the primary prediction. In parallel, a second batched Jev call on the context-only state yields the baseline for every candidate. It persists the chosen question's primary and baseline predictions, then returns. Target p50 ≤ 800 ms.
- **`POST /answers`** validates and persists the answer, scores the sealed predictions, updates fidelity and enqueues learning. Target p50 ≤ 300 ms.

Asynchronous jobs, on Queue `mimic-jobs`. The identity jobs a person waits on during sign-up run on their own Queue, `mimic-identity`, so question generation never holds them up (ADR-0034):

| Job | Trigger | What it does |
|---|---|---|
| `identity.search` | Intake submitted, or "Search with a link" | Exa people search (and a lookup of the person's link) finds candidates; Jev pre-ranks them with a `noul` "same person?" question |
| `identity.enrich` | Person confirms a candidate | Exa reads the confirmed profile and produces facts with sources (Parallel optional) |
| `pool.refill` | Pool drops below 6 | LLM generates candidates; they are validated, gated by Jev, deduped and inserted |
| `predict.shadow` | Question served | LLM predictors run on the sealed state (§3.1) |
| `learn.answer` | Answer submitted | Embed the Q&A; Jev trait read; every R answers, reflection and KG update; snapshot (debounced) |
| `hypotheses.refresh` | After a reflection | BALD and `voi`: sample K persona hypotheses |
| `stats.refresh` | Cron, hourly | Recompute the aggregate cross-person item statistics (§12.6a) |

Job rules:

- **Idempotent.** The dedupe key is the job type plus its IDs plus seq. `learn.answer` also carries the answer ID, so
  a re-answer after an undo is learned again (ADR-0036).
- **Monotonic writes.** A job writes derived state only if its `seqUpTo` is greater than the stored one.
- **Resilient.** Retries with backoff, and a dead-letter queue.
- **Logged.** Every job logs its model calls.

Cold start needs no LLM. The first 10 questions are static anchors, which gives the pool time to fill.

### 6.5 Bindings, secrets, environments

**Bindings** (`wrangler.jsonc` in both apps):

| Binding | Resource |
|---|---|
| `DB` | D1 database `mimic` |
| `BLOBS` | R2 bucket `mimic-blobs` |
| `CACHE` | KV namespace |
| `VEC` | Vectorize index `mimic-qa` |
| `JOBS` | Queue `mimic-jobs` (web produces, worker consumes) |
| `IDENTITY_JOBS` | Queue `mimic-identity`: `identity.search` and `identity.enrich` (ADR-0034) |
| `AI` | Workers AI |
| `RL` | Rate limiter |

**Vectorize.** Create a metadata index on `mimicId` so queries can filter by it.

**Secrets.** Set these with `wrangler secret put`, and keep local copies in `.dev.vars`:

- `OPENROUTER_API_KEY`
- `EXA_API_KEY`
- `PARALLEL_API_KEY`
- `PERPLEXITY_API_KEY` (optional)
- `SESSION_SECRET`
- `ADMIN_EMAILS`
- `INVITE_CODES` (comma-separated, for the private cohort)

**Environments.** `dev` runs locally on Miniflare; `preview` and `prod` are deployed. Each environment gets its own D1, R2, KV and Vectorize resources.

---

## 7. Core types (`packages/core`)

```ts
export type QType = 'choice' | 'noul' | 'score';
export type QKind = 'anchor' | 'adaptive' | 'repeat' | 'playground' | 'feedback';
export type Domain = 'core' | 'casual' | 'professional';

export interface Option { key: string; label: string; description?: string }

export interface Question {
  id: string; mimicId: string; seq: number | null;        // seq assigned when served
  kind: QKind; type: QType; domain: Domain;
  prompt: string;                                          // shown to the person
  options: Option[];                                       // choice: 2–5; noul: yes/no; score: 5 ordered, low → high
  facetIds: string[];
  repeatOf?: string;                                       // kind = 'repeat'
  provenance: { generator: string; configHash: string; promptVersion: string };
}

export type Distribution = Record<string, number>;          // option key → p, sums to 1

export interface Evidence { questionId: string; seq: number; answer: string; why?: string; latencyMs: number }

export interface PersonState {                              // what predictors see (built by StateBuilder)
  identity: Record<string, unknown>;                        // intake + active facts
  traits?: TraitEstimate[];
  insights?: Insight[];
  evidence: Array<{ seq: number; q: string; type: QType; options: string[]; answer: string; why?: string }>;
  meta: { evidenceSeqMax: number; stateHash: string; builder: string; tokens: number };
}

export interface PredictionResult {
  dist: Distribution; confidence?: number; costUsd: number; latencyMs: number; modelSnapshot: string;
}
export interface Predictor {
  id: string;                                               // 'jev:typesafe/jev-1.13', 'llm:openai/gpt-6-luna', …
  predict(state: PersonState, qs: Question[]): Promise<PredictionResult[]>;
}
export interface CandidateGenerator { generate(ctx: GenContext, n: number): Promise<Question[]> }
export interface Selector {
  select(ctx: SelectContext): Promise<{ question: Question; primary: PredictionResult; diagnostics: Record<string, number> }>;
}
export interface StateBuilder {
  build(m: MimicData, opts: { forQuestions?: Question[]; budgetTokens: number; contextOnly?: boolean }): PersonState;
}
export interface TraitReader { read(state: PersonState, facets: Facet[]): Promise<TraitEstimate[]> }
export interface Reflector { reflect(state: PersonState, newEvidence: Evidence[]): Promise<ReflectionDelta> }
export interface DecisionProvider { decide(req: DecisionRequest): Promise<DecisionResponse> } // Jev now, OpenAI later
```

### 7.1 `PipelineConfig`: the unit of experimentation

```ts
export const PipelineConfig = z.object({
  version: z.literal(1),
  ontologyVersion: z.string(),                                         // 'v1'
  anchors: z.object({ setId: z.string(), count: z.number().int() }),
  generator: z.object({
    model: z.string(),
    reasoningEffort: z.enum(['none', 'low', 'medium']),
    promptVersion: z.string(),
    batchSize: z.number().int(),
    domainMix: z.object({ core: z.number(), casual: z.number(), professional: z.number() }),
    gates: z.string().optional(),                                      // gate set; 'gates.v2' when absent (ADR-0042)
  }),
  reserve: z.object({ setId: z.string() }).optional(),                 // 'reserve.v1' when absent (ADR-0042)
  selector: z.discriminatedUnion('type', [
    z.object({ type: z.literal('random') }),
    z.object({ type: z.literal('coverage') }),
    z.object({ type: z.literal('entropy'), lambdaCoverage: z.number(), muRedundancy: z.number() }),
    z.object({ type: z.literal('bald'), k: z.number().int(), lambdaCoverage: z.number() }),
  ]),
  predictor: z.object({ primary: z.string(), shadows: z.array(z.string()) }),
  stateBuilder: z.object({
    strategy: z.enum(['raw', 'structured', 'summary', 'full']),
    budgetTokens: z.number().int(), retrievalK: z.number().int(), recentN: z.number().int(),
  }),
  traitReader: z.object({ type: z.enum(['jev', 'none']), everyN: z.number().int() }),
  reflector: z.object({
    model: z.string().nullable(), everyN: z.number().int(), promptVersion: z.string(), requireCitations: z.literal(true),
  }),
  repeats: z.object({ every: z.number().int(), minGap: z.number().int() }),
  reveal: z.enum(['after_answer', 'never']),                           // show the mimic's guess after answering
  session: z.object({ target: z.number().int(), budgetUsd: z.number() }),
});
```

`configHash = sha256(canonicalJson(config))`. Config rows are immutable, and experiments reference them by hash.

**Default config `cfg.default.v1`:**

| Setting | Value |
|---|---|
| Anchors | `anchors.v1`, 10 items |
| Generator | GPT-6 Luna, low reasoning effort, batch of 12, domain mix core 10 / casual 45 / professional 45 |
| Selector | `entropy` with λ = 0.3, μ = 0.5 (v1–v3); `voi` since v4: K 4, λ 0.3, μ 0.5, β 0.25, γ 0.25, π 0.15, ν 0.2, exposure cap 0.35 (ADR-0027) |
| Predictors | Primary `jev:typesafe/jev-1.13`; shadows are the three LLMs |
| State builder | `full`, 8,000 tokens, retrievalK 12, recentN 6 |
| Trait reader | Jev, after every answer |
| Reflector | GPT-6 Luna, every 5 answers |
| Repeats | Every 8 questions, minimum gap 6 |
| Reveal | `after_answer` |
| Session | Target 30 questions; budget $0.50 in the config, which marks the standard budget that `BUDGET_USD` sets ($1 by default); the session spends 80% of it (ADR-0035) |

---

## 8. Data model (D1 via Drizzle)

IDs are ULIDs, so they sort by time. Timestamps are integer milliseconds. JSON columns are validated with zod on read.

```
participants        id, email?, is_admin, created_at
mimics              id, participant_id, display_name, location, occupation?, employer?, links_json,
                    status(intake|identity|learning|paused|archived), config_hash, experiment_id?, arm?,
                    consent_app, consent_search, consent_research,
                    categories_json, consents_json, research_consents_json, scope_at?   (ADR-0040),
                    split(dev|test),
                    seq_max, evidence_epoch (ADR-0036), snapshot_version, spend_usd, created_at, updated_at
identity_candidates id, mimic_id, provider, rank, name, headline, location, url, summary,
                    jev_same_person_p, r2_key, status(proposed|confirmed|rejected), created_at
facts               id, mimic_id, predicate, object, source(intake|search|answer|reflection), source_ref,
                    source_url?, confidence, user_state(active|removed), created_at
questions           id, mimic_id, seq?, kind, type, domain, prompt, options_json, facet_ids_json, repeat_of?,
                    status(pooled|served|answered|discarded), config_hash, prompt_version, generator,
                    quality_json, selection_json?, created_at, served_at?
predictions         id, question_id, mimic_id, predictor_id, role(primary|baseline|shadow|hypothesis),
                    dist_json, confidence?, state_hash, evidence_seq_max, config_hash, model_snapshot,
                    cost_usd, latency_ms, ok, error?, hypothesis?, created_at
item_stats          key PK, kind(item|archetype), n_people, n_answers, answer_entropy?, baseline_error,
                    primary_error, surprise, lift?, mean_latency_ms, updated_at   (aggregate only; §12.6a)
answers             id, question_id, mimic_id, seq, value, why?, latency_ms, revealed_prediction,
                    idempotency_key UNIQUE, created_at
answer_rewinds      id, mimic_id, question_id, seq, answer_id UNIQUE, value, why?, latency_ms, revealed_prediction,
                    idempotency_key, answered_at, rewound_at    (undone answers, ADR-0036)
scores              prediction_id PK, answer_id, top1, item_acc, log_loss, brier, created_at
trait_estimates     PK(mimic_id, facet_id, method) method(jev|psychometric), seq_up_to, mean, dist_json,
                    confidence, n_evidence, config_hash, created_at
trait_history       append-only copy of every trait_estimates write (charts, replay)
insights            id, mimic_id, seq_up_to, text, facet_ids_json, evidence_seqs_json, confidence, model,
                    prompt_version, status(active|superseded|user_rejected), created_at
kg_nodes            id, mimic_id, type(Person|Organization|Place|Occupation|Skill|Interest|Facet),
                    label, props_json, source, created_at
kg_edges            id, mimic_id, src, dst, predicate, weight, source, source_ref, created_at
fidelity            mimic_id, seq_up_to, acc, acc_baseline, self_consistency, fidelity, ci_low, ci_high,
                    n_scored, n_repeats, state(calibrating|learning|stable), created_at  (append-only)
model_calls         id, mimic_id?, job_key?, purpose, provider, model, model_snapshot, input_tokens,
                    output_tokens, cost_usd, latency_ms, ok, error?, config_hash, r2_trace_key, created_at
configs             hash PK, json, label, created_at
experiments         id, name, status, arms_json [{arm, config_hash, weight}], created_at
snapshots           mimic_id, version, r2_key, seq_up_to, created_at
eval_runs           id, name, spec_json, dataset_hash, status, metrics_json, r2_report_key, created_at
jobs                key PK, type, status, attempts, last_error, updated_at    (idempotency ledger)
persona_drafts      id, mimic_id, seq_up_to, config_hash, prompt_version, model, model_snapshot,
                    draft_json, created_at                                    (soul.v1, §8.3)
persona_curations   mimic_id PK, json, rev, updated_at                        (the person's choices, §8.3)
```

KG node types follow schema.org names where one exists.

**Indexes:**

- `mimic_id` on every table that has it
- `(mimic_id, seq)` on `questions` and `answers`
- `(question_id, role)` on `predictions`
- `created_at` on `model_calls`

**R2 layout:**

```
traces/{yyyy-mm-dd}/{callId}.json          model request/response, keys redacted
search/{mimicId}/{provider}/{ts}.json      raw search payloads
snapshots/{mimicId}/v{n}.json              immutable mimic.json (§8.1)
evals/{runId}/report.{json,md}
```

**KV keys:**

- `search:{sha256(norm(name|location|occupation))}`, with a 7-day TTL
- `cfg:active`
- `exp:registry`

**Vectorize** (`mimic-qa`): one vector per answered Q&A and one per fact. Metadata is `{ mimicId, kind, facetIds, seq }`. Always filter queries by `mimicId`.

### 8.1 The persisted mimic (`mimic.json`)

The snapshot is immutable, versioned and portable. It's written on a debounce after learning, and again when a session ends.

```json
{
  "schema": "mimic/1",
  "mimicId": "01J…", "version": 7, "createdAt": 0, "seqUpTo": 34,
  "subject": { "displayName": "…", "location": "…", "occupation": "…" },
  "facts": [{ "predicate": "worksAt", "object": "…", "source": "search", "url": "…", "confidence": 0.9 }],
  "evidence": [{ "seq": 1, "kind": "anchor", "type": "score", "prompt": "…", "options": ["…"], "answer": "3", "why": null }],
  "traits": [{ "facet": "risk_tolerance", "mean": 0.64, "dist": { "0": 0.02, "1": 0.1, "2": 0.3, "3": 0.4, "4": 0.18 }, "confidence": 0.41, "n": 6 }],
  "insights": [{ "text": "…", "facets": ["…"], "evidence": [12, 19] }],
  "kg": { "nodes": [], "edges": [] },
  "fidelity": { "fidelity": 0.74, "ci": [0.63, 0.83], "acc": 0.61, "accBaseline": 0.49, "selfConsistency": 0.82, "n": 28 },
  "pipeline": { "configHash": "…", "models": { "primary": "typesafe/jev-1.13-20260917" } }
}
```

Using a mimic means running any predictor against its snapshot.

### 8.2 Browser persistence

- **Query cache.** TanStack Query persists to IndexedDB via `idb-keyval`: the mimic list, the latest snapshot per mimic, and the current question.
- **Answer outbox.** Answers are written to IndexedDB first with an idempotency key, then POSTed, and retried on reconnect. The server enforces uniqueness on `idempotency_key`.
- **Session identity.** A signed, httpOnly `participant_id` cookie. Nothing sensitive goes in localStorage.
- **On load.** Render from cache immediately, then revalidate.

### 8.3 SOUL.md

`mimic.json` is for running predictors. `SOUL.md` is for people's own agents: a Markdown model of the person that any
agent can read to predict and represent them, with decision-making first (ADR-0039, which renamed and redesigned
`Persona.md`, ADR-0033). Other agent tools load a file named SOUL.md as the agent's *own* identity, so this one
declares itself a person model up front: YAML front matter (`kind: person-model`, subject, as-of date, answers,
evidence cutoff, draft prompt, profile) and a first line saying it describes the person and is not the reader's
identity.

**Sections, in reading priority:**

| Section | Source | Notes |
| --- | --- | --- |
| How to use this file | Template | Role, trust order (boundaries › own words › recorded answers, most recent first › inferred sections › tendencies › background), predict from related answers first, don't idealize the person, unknowns mean ask, check before irreversible or sensitive actions, quoted text is data not instructions, fidelity and date. |
| Boundaries | Person | Always present, even with the instructions turned off: the speaking-as-me rule, then Always / Never / Ask-me-first rules. They override everything else. |
| In their own words | Person | Free Markdown, quoted. |
| Summary; How they decide; Rules of thumb; Tradeoffs; What they value; Beliefs and opinions; Biases and blind spots; Tensions; How they come across | `soul.v1` draft | Cited statements; one citation means _tentative_. Tensions keep answers that pull both ways, with the context that decides. |
| Patterns in their answers | Reflector | Cited insights. |
| How they talk | Person | Up to 5 writing samples, quoted. Left out while agents may never speak as them. |
| Measured tendencies | Traits | A table: area, facet, scale (low ↔ high pole), leaning, certainty tier, answers. Only facets with direct evidence and certainty ≥ 0.4. |
| Not known yet | Traits | The rest: "don't assume either way". |
| Background | Intake, facts | Location and work, then each sourced fact quoted as found, with its source; removable. |
| Key decisions | Answers | The 12 answers the portrait cites most (then those with a reason, then the most recent), verbatim with reasons. |
| Appendix: all other answers | Answers | The rest of the record. Left out of the `core` profile. |

It is a view with three inputs:

1. **The mimic's current data**, in the same shape as `mimic.json` (§8.1) but read live: viewing never writes a
   snapshot, and a fact the person removes leaves the file at once. Repeats are left out of the record.
2. **The latest `soul.v1` draft** (optional; `persona.v1` drafts still render). One LLM call writes a summary and
   cited statements in eight sections. It is told to be specific enough to be wrong and not to make the person more
   rational, agreeable, consistent or optimistic than their answers. The writer never sees the person's name
   (redacted wherever it appears), `headline` facts or repeats. The reflector's citation guard applies, limited to
   the answers the writer was shown. Draft text that mentions a fact the person later removed is left out. Drafts
   store the evidence seq they cover, config, prompt version and model snapshot, and say how many answers have
   arrived since.
3. **The person's curation:** the name to use, boundaries, whether agents may speak as them (never; when asked,
   saying it's an AI, the default; or when asked), their own words, voice samples, sections on or off, hidden items,
   and rewordings of drafted statements. Saves carry an increasing `rev`, and the server ignores one older than what
   it has.

**Profiles.** `full` (the default download) is the core plus the appendix; `core` (`?profile=core`) leaves the
appendix out, for system prompts with a small budget, and downloads as `SOUL.core.md`. The page shows both sizes.

Curation only filters, rewords and adds the person's own rules and words. It never feeds back into states, traits or
predictions. Citations appear only for answers that are in the file. Hard delete covers both tables. Research exports
always drop curations, and drop drafts too unless identity is kept (`--keep-identity`), since drafts are free text
written from location and sourced facts.

---

## 9. The learning engine

### 9.1 Intake

Required fields:

- Name
- Location: a city, state or country, suggested as you type (ADR-0030). A city is best for identity search, so the hint asks for it first.
- Attestation: "I'm building a mimic of myself"

Optional fields:

- Occupation
- Employer or school (students and recent graduates enter their school; stored as `employer`, ADR-0029)
- One link, such as LinkedIn or a personal site (this improves identity matching a lot)

Optional consents, each a separate checkbox:

- "Search the public web for information about me." If unchecked, skip §9.2 entirely.
- "Use my answers, without my name or location, for research." This gates inclusion in evals.

What to ask about (ADR-0040, `docs/CATEGORIES.md`):

- Four categories, all selected by default, each deselectable: Personality and psychology; Values, beliefs and
  politics; Relationships, sexuality and life; Work and money. A deselected category is never asked about or learned.
- Five sensitive areas, each its own consent under its category with a one-line reason and "Your answers stay
  yours: they are only used to build your mimic": political views, religion and worldview, sexuality and intimate
  relationships, health and body, money in detail. All ticked by default; each can be turned off (ADR-0049).
- With research consent on, a separate opt-in per special-category area (politics, religion, sexuality, health)
  allows its answers in research exports.
- All of it can be changed later from the session menu.

### 9.2 Identity resolution and enrichment

1. **Search.** `identity.search` runs Exa with `category: "people"`. Use 2 plain-language query variants that lead with the name, never quoted (Exa's people index is semantic; ADR-0029): `{name}, {occupation} at {employer}, {location}` and the same without the location, plus the name alone only if those find nobody with the full name; or `{name}, {location}` and the name alone when there is no role (ADR-0034). If the person gave a link, read it with Exa `/contents` first; when it resolves to a profile with their full name, skip the search. Request `numResults` 10 with highlights, then merge by reciprocal rank, dedupe by profile URL and drop profiles with no name in common with the intake (the person's own link is always kept). Cache complete, non-empty results in KV and store raw results in R2.
2. **Pre-rank.** For each candidate, one Jev request (all run in parallel, state = intake plus that candidate's summary) asks the `noul` question "Is this profile the same person as the intake?". Store the result as `jev_same_person_p`.
3. **Confirm.** The UI asks "Is one of these you?" and shows the top 3–5 candidates with name, headline, location and source; namesakes Jev scores low are behind "Show more". The person picks one or chooses "None of these". Never auto-confirm. If they aren't listed, they can search again with a link to their profile.
4. **Enrich.** A candidate from Exa search carries its person entity's facts (current role and employer, employer history, schools, location), so confirming it writes them, sourced to the profile, with no call. Otherwise `identity.enrich` runs on confirmation: Exa `/contents` reads the confirmed profile, and a page without an entity (a personal site) gets an Exa schema summary with the same fields a Parallel Task would return, including skills, public projects and writing, and interests. `ENRICH_PROVIDER=parallel` switches to a Parallel Task (ADR-0034).
5. **Review.** The person sees every fact with its source and can remove any of them. Removed facts never enter any state.
   Special-category facts (politics, religion, sexuality, health) are never requested and are dropped before they
   are stored, whatever the person consented to (ADR-0040).
6. **Use.** Active facts become `identity` in `PersonState`. Together with intake, they are everything the baseline predictor sees.

If search is declined or finds nothing, continue with intake only.

### 9.3 Anchor battery (`docs/ontology/anchors.v1.json`)

Ten static items, the same for everyone, shown in random order per person. All are typed:

- **Big Five.** Five items, one per trait, taken from IPIP (public domain) and asked as 5-point `score` questions.
- **Economic preferences.** One risk choice (sure gain vs. gamble), one intertemporal choice (smaller-sooner vs. larger-later), and one trust/reciprocity item.
- **Context.** One work-style dilemma and one everyday preference.

The anchors serve three purposes: a cross-person comparable eval set, a psychometric sanity check, and a cold start with zero latency.

### 9.4 Candidate generation (`pool.refill`)

**Generator input,** stable prefix first:

1. System prompt and style rules
2. Ontology facet list with definitions
3. Question-type specs
4. Exclusion list
5. Target facets: the 5 with the lowest coverage or confidence, plus the domain quota from `domainMix` (`gen.v1`). Since `gen.v2` (ADR-0027): the 5 with the highest belief-state need, each with why it is targeted and the person's current reading, facets over the exposure cap to avoid, and a quota tilted toward the weakest domains (§9.5).
6. Person context: compact identity facts, trait summary, the last 10 questions (to avoid repeats), and occupation-specific facets

**Generator output** (JSON schema):

```
{ questions: [{ type, domain, prompt, options: [{ key, label }], facetIds, rationale }] }
```

**Gates,** applied in order:

1. **Schema.** zod validation, including option count by type: choice has 2–5 options, noul has yes/no, and score has exactly 5 ordered low → high.
2. **Quality.** For each candidate, one Jev request (all run in parallel) uses that candidate as its state and asks four `noul` gates:
   - Is it ambiguous?
   - Does it touch a sensitive topic?
   - Is it leading or loaded?
   - Could anyone answer it in about 10 seconds?

   A candidate fails a gate when the bad outcome is likely: p(yes) > 0.6 for the first three, or p(yes) < 0.4 for the last. Drop failures, and tune these thresholds on a small labeled set.

   **gates.v3** (`generator.gates`, ADR-0042) adds two gates and changes two:
   - **Concrete:** does it put the person in one specific, everyday situation and ask what they would do? Fails
     below 0.4. Self-ratings and abstract opinions fail it.
   - **Demeaning:** does it presume, judge, stereotype or shame, or leave out answers some people would give?
     Fails above 0.5.
   - **Sensitive** asks only about the areas the draft is not tagged with, and about the answerer's own life
     (caring for patients at work does not count). A consented, correctly tagged sensitive draft is checked
     against the other areas; an untagged draft against all five. Fails above 0.3.
   - **Leading** judges the wording, not whether one option is more admirable. Fails above 0.4.

   Thresholds were chosen on `packages/eval/labeled/gates.v3.json` and checked on `gates.v3.heldout.json`
   (`pnpm eval -- gates`; report in `docs/reports/m10-gates.md`). `quality_json` records `gatesVersion` and, for
   gates.v3, `sensitiveAsked`.
3. **Dedupe.** Drop any candidate with cosine similarity > 0.9 to an asked or pooled question.
4. **Insert** survivors as `pooled`. Keep the pool between 6 and 15 questions.

**Style rules** for the generator prompt:

- Prefer concrete scenarios over abstractions.
- One idea per question, at most 30 words.
- Options are mutually exclusive and roughly equally attractive.
- No "it depends" option.
- Ground professional scenarios in the person's stated occupation.
- Never mention the model or the person's name.

`gen.v3` (ADR-0042) makes these rules strict: one specific situation per question, options that are actions,
self-rating forms forbidden by name, everyday scenes for everything outside "Work and money", a quota per selected
category, and sensitive facets only when consented, asked plainly with options covering the range. Without "Work and
money" in scope, workplace scenes are rejected in code and the professional quota is zero, for every generator.

### 9.5 Selection

Every strategy scores pooled questions only. Repeat probes are scheduled outside the selector. The default since
`cfg.default.v4` is `voi` (value of information), specified in `docs/SELECTION.md` and ADR-0027; `cfg.default.v8` adds
category and facet-group balance, the trust ramp and the sensitive sweep (`docs/SELECTION.md` §5a, ADR-0044). The
strategies below remain as controls and experiment arms.

- **`random`** is the control arm.
- **`coverage`** takes the facet with the lowest coverage, breaking ties randomly.
- **`entropy`** (default). One Jev request predicts all pooled candidates on the current state, and the selector picks the argmax of:

  ```
  score(q) = H(p_q) / log|options_q| + λ · (1 − coverage(q)) − μ · maxSim(q, asked)
  ```

  The chosen question's distribution is the sealed primary prediction, so no extra call is needed.
- **`bald`** (M8). The LLM generates K persona hypotheses asynchronously: alternative readings of the person, cached per reflection. K Jev requests then run in parallel, each with one hypothesis added to the state and each predicting every candidate. Pick the argmax of:

  ```
  MI(q) = H(mean_k p_k(q)) − mean_k H(p_k(q))    (+ coverage bonus)
  ```

  This favors questions where plausible versions of the person disagree, rather than questions that are merely noisy. The sealed primary prediction still comes from a separate Jev call on the plain state, so BALD costs K + 1 Jev calls per selection. That stays cheap because Jev bills input tokens only.
- **`voi`** (default since v4; `docs/SELECTION.md`). A **belief state** is built from the person's own data before each
  selection: per facet, uncertainty (trait-read entropy and confidence), conflict (Jev vs psychometric reads,
  superseded insights, repeat flips, torn answers), weakness (the sealed primary's recent error on that facet),
  coverage and exposure; per domain, share and weakness; per person, median latency, speeding and straightlining.
  The selector picks the argmax of:

  ```
  score(q) = info(q) + λ·gap(q) + β·conflict(q) + γ·weakness(q) + π·(pop(q) − ½) − μ·redundancy(q) − ν·burden(q)
  ```

  `info` is the posterior-weighted BALD mutual information over K persona hypotheses when they exist (weights
  come from each hypothesis's likelihood of the answers given since the set was written, read from stored
  `role = hypothesis` rows), else the normalised predictive entropy. `gap` balances facet and domain coverage,
  `pop` is a shrunk cross-person item statistic (§12.6a), and `burden` prefers short prompts and interleaved
  types and domains as the session grows. Candidates whose facets already take more than `exposureCap` of the
  adaptive questions are skipped. The winning score's components are stored on the question
  (`questions.selection_json`). The generator (`gen.v2`) targets the facets with the highest **need** and is told
  the person's current reading on each, so it writes trade-offs pitched at that reading.

**Repeat schedule.** After every `repeats.every` adaptive questions, re-serve an earlier answered anchor or adaptive question verbatim, at least `minGap` questions after it was first asked. Repeats are excluded from learning and from fidelity accuracy, and no predictions are made for them. They feed self-consistency only.

### 9.6 Prediction

When a question is served:

1. **Primary.** Jev on `state(answers < t)`. This comes from the selector call.
2. **Baseline.** Jev on `state(contextOnly)`.
3. **Shadows.** Enqueue `predict.shadow` for each shadow LLM, using the same sealed state (identical `stateHash`).

**Jev templates:**

- Instructions: `Predict how the person described in the state would answer this question, based only on the state: "{prompt}"`
- Choice criteria, per option: `The person would choose: {label}`
- Noul criteria: `true` → `The person would answer yes`, `false` → `The person would answer no`
- Score criteria: the 5 labels, in order

**LLM predictor.** Render the same state as compact text and require the JSON schema `{ "probs": [{ "key": string, "p": number }] }`. Normalize the probabilities, clip them to [1e-4, 1], then renormalize. Store invalid outputs as `ok = false`, exclude them from metrics, and count the failures.

### 9.7 Scoring (on answer)

For each sealed prediction of the answered question:

- **`top1`:** 1 if the argmax option equals the answer, else 0.
- **`item_acc`:** equal to `top1` for choice and noul. For score items it is `1 − |E[index] − answerIndex| / 4`, which matches the "1 − MAD/range" accuracy used in digital-twin studies.
- **`log_loss`:** `−ln max(p(answer), 1e-4)`.
- **`brier`:** `Σ_k (p_k − 1[k = answer])²`.

Calibration bins are computed in analysis, not stored.

### 9.8 Learning (`learn.answer`)

1. **Embed** the Q&A (plus the "why") into Vectorize.
2. **Read traits** after every answer. One Jev request asks one `score` question per facet, with 5 ordered pole labels, on the current state. It yields `mean` (expected index / 4), `dist` and `confidence`. The Big Five anchor items also get deterministic psychometric scoring (`method = psychometric`) as a sanity check.
3. **Reflect** every `reflector.everyN` answers. The LLM returns `{ insights: [{ text, facetIds, evidenceSeqs, confidence }], facts: [{ predicate, object, evidenceSeqs }], contradictions: [...] }`.
   - Drop any insight that cites no evidence seq. This guards against stereotyping.
   - When new evidence contradicts an insight, mark it superseded rather than deleting it.
   - Facts become KG edges with provenance.
4. **Add occupation facets** on the first learn after identity is settled. Generate 3–5 profession-specific facets and add them to this mimic's facet set. These can optionally be seeded from O*NET work styles for the occupation (O*NET is CC BY 4.0).
5. **Snapshot** on a debounce of about 10 seconds, and on session end.

### 9.9 State builder (budgeted)

Jev's context is 32K tokens. LLM contexts are larger, but cost scales with tokens. The default budget is 8,000 tokens, estimated as characters / 4. Sections, in priority order:

1. **`identity`** (≤ 600 tokens): intake plus active facts.
2. **`traits`** (≤ 500): facets with mean and confidence. Included by the `structured` and `full` strategies.
3. **`insights`** (≤ 800): active, cited insights only. Included by `summary` and `full`.
4. **`evidence`**: include every answered item while it fits the budget. A 30–40 question session is only about 2–3K tokens, so the synchronous path needs no retrieval. Once evidence outgrows the budget, include every anchor, the top `retrievalK` Q&A by embedding similarity to the target question(s) (or to the centroid of a candidate batch), and the last `recentN` answers. Always dedupe, and truncate each "why" to 200 characters. With `stateBuilder.latencyHints` (on since v4; builder `full.v2`), each item also carries `pace: quick | slow` when it was answered in under half or over twice the person's median latency over the sealed evidence (response time reveals strength of preference; `docs/SELECTION.md` §8).

Ablation strategies:

| Strategy | Contents |
|---|---|
| `raw` | identity + evidence |
| `structured` | identity + traits |
| `summary` | identity + insights |
| `full` | everything |

`stateHash = sha256(canonicalJson(state))`.

### 9.10 Headline fidelity

Recomputed after every answer and appended to the `fidelity` table.

**Inputs:**

- **Scored set S:** the most recent 30 primary predictions on anchor and adaptive questions. Repeats, playground and feedback questions are excluded.
- **`acc`:** mean `item_acc` over S.
- **`acc_baseline`:** the same, for the baseline predictions on S.
- **Self-consistency `c`:** agreement across repeat pairs. For categorical items agreement is 1 if the answers match, else 0. For scale items it is `1 − |a1 − a2| / 4`. Smooth toward a prior:

  ```
  c = (Σ agree + 5 · 0.8) / (n_repeats + 5)
  ```

  The 0.8 prior is roughly the two-week consistency reported for survey items. Revisit it once real repeat data exists.

**Outputs:**

- `fidelity = min(1, acc / c)`, with a 90% CI from a 1,000-resample bootstrap over S holding `c` fixed. Show `n_repeats` alongside.
- **State:** `calibrating` while |S| < 12; `stable` once the CI half-width is ≤ 0.05; `learning` otherwise.

**UI copy:**

- "Predicts you {fidelity}% as well as you predict yourself"
- "{acc − acc_baseline} points better than a guess from your profile alone"

Per-facet "certainty" in the UI is Jev's confidence for that facet's trait read. Label it as certainty, never as accuracy.

### 9.11 Talk to your mimic (M6)

1. The person writes a scenario.
2. An LLM turns it into a typed question, whose options the person can edit.
3. Jev predicts on the full state, and the UI shows the distribution. Optionally, an LLM adds one sentence of rationale in the person's voice, labeled "generated".
4. The person then answers the question themselves. The answer is stored as `kind = playground` evidence and scored separately, which builds a clean, user-verified test set.
5. Instead of asking (step 3), the person can answer the question themselves right away: "Answer it myself". The question can also be written by hand, without step 2's LLM. The answer is stored as `kind = feedback`, with no predictions, in one atomic write. If a session question is open, the feedback takes its seq and the question moves to the next one, so answers are learned in order. Unlike playground answers, feedback is evidence the mimic learns from: it enters later sealed states, embeddings, trait reads and reflection like a session answer. It is never scored and never counts toward session progress (ADR-0032).
6. The page lists what was asked and taught, newest first. An asked question left unanswered can be answered from that list.

---

## 10. UX

### 10.1 Screens

| Route | Purpose |
|---|---|
| `/` | One sentence on what Mimic does, and one button: "Build your mimic". |
| `/new` | Intake (§9.1). Required fields are marked, and each consent is explained in one line. An invite link (`?invite=CODE`) fills the code in and hides the field (ADR-0047). Location and occupation suggest as you type (ADR-0030). |
| `/m/[id]/identity` | Search progress, "Is one of these you?", then fact review with remove toggles. "Skip" is always available. |
| `/m/[id]` | The session. |
| `/m/[id]/mimic` | Talk to your mimic (§9.11): ask it, or teach it an answer; download `SOUL.md` and `mimic.json`; delete the mimic. |
| `/m/[id]/soul` | Curate `SOUL.md` (§8.3): write or rewrite the inferred sections; set boundaries, whether agents may speak as you, your own words and voice samples; include or hide sections and items; reword statements; preview, copy and download (full or core). `/m/[id]/persona` redirects here. |
| `/credits` | The attribution the autocomplete data's licenses require (ADR-0030), linked from the footers of `/` and `/new`. |
| `/lab` | Admin only. |

**Session layout.** On desktop, the model panel sits on the left (about 40%) and the question on the right. On mobile, the question fills the screen, and a compact fidelity chip at the top opens the panel as a bottom sheet.

**Question card:**

- The prompt is set in large type.
- Controls by type: full-width option buttons (choice), Yes/No (noul), or a 5-step segmented scale (score).
- An optional "Why?" field, collapsed by default.
- Keyboard: 1–5, Y/N and Enter.

**After answering** (when `reveal = after_answer`), a 600 ms inline reveal shows "Your mimic guessed B (62%)" with a match or miss mark, then the next question.

**Undo.** The latest answer can be undone, once, after a simple confirmation: "Undo" next to Next during the reveal,
or "Undo last answer" on the question after it. The question comes back with its sealed predictions, and the answer
is kept as a rewind, not as evidence (ADR-0036).

**Progress** reads "12 of ~30", with "Stop here" always available. Stopping never loses the mimic.

**Model panel** (left):

1. **Headline fidelity,** with its CI and state, a rolling sparkline, and lift over baseline.
2. **Facet bars,** grouped as Personality, Values, Decisions, Work, Everyday and Communication. Each bar shows a mean marker and a certainty band. Hovering a bar shows the answers that support it.
3. **"What it's learned":** the latest cited insights, each linked to its evidence.
4. **Your map** (ADR-0046): the knowledge graph as a network of the things in the person's life (work, places, interests, skills, traits), clustered by category, with typed links inferred between them and a confidence threshold; at most 60 nodes.
5. **Coverage:** facets not yet explored.

**Lab** (`/lab`):

- Configs, experiments and eval runs.
- Fidelity vs. number of questions, per arm.
- Log loss, accuracy and ECE per predictor.
- Cost and latency per call type.
- The fidelity-per-dollar frontier.

### 10.2 Visual direction

This is a brief for the frontend work. Refine it with the frontend-design skill before building screens.

- **Subject:** a portrait being drawn from answers.
- **Signature element:** the fidelity headline shown as two overlapping circles, "You" and "Mimic", whose overlap grows with fidelity. Keep everything else quiet.
- **Color carries meaning.** Graphite is the person's answers; one cool ink color is the mimic's predictions; muted green and rust mark match and miss. Use a cool neutral background, not cream.
- **Typography.** Question prompts use a readable text serif at a large size, because they are sentences to think about. UI chrome uses one neutral sans. Sentence case, plain verbs, no eyebrow labels.
- **Motion.** Only the reveal and the fidelity update animate, and reduced-motion settings are respected.
- **Components.** shadcn/ui with Tailwind; visx (or Recharts) for charts; d3-force with an SVG renderer for the map (ADR-0046).

---

## 11. API (Next route handlers, zod in and out)

| Method and path | Request → response | Notes |
|---|---|---|
| `POST /api/mimics` | intake, with an optional `scope` → `{ mimicId }` | Enqueues `identity.search` if consented; scope defaults to every category, no sensitive area (ADR-0040) |
| `GET /api/mimics/:id` | → UI snapshot | Profile, fidelity, facets, insights, KG, pool status |
| `GET /api/mimics/:id/identity` | → `{ status, candidates, facts }` | |
| `POST /api/mimics/:id/identity/confirm` | `{ candidateId \| null }` | Enqueues `identity.enrich` |
| `POST /api/mimics/:id/identity/search` | `{ link }` | Searches again led by the link; only while a choice is pending (ADR-0029) |
| `PATCH /api/mimics/:id/facts/:factId` | `{ userState: 'removed' \| 'active' }` | |
| `PATCH /api/mimics/:id/scope` | `MimicScope` → `{ scope, scopeAt, discarded }` | Categories, consents and confirmations; narrowing hides what was learned in the withdrawn areas (ADR-0043, ADR-0050) |
| `POST /api/mimics/:id/decline` | `{ questionId }` → `{ scope, scopeAt, discarded }` | "Prefer not to say" on the served sensitive question: its sensitive facets are never asked again; 409 for a question on no sensitive facet (ADR-0050) |
| `POST /api/mimics/:id/next` | → `{ question, seq }` | Idempotent per seq; seals predictions |
| `POST /api/mimics/:id/answers` | `{ questionId, value, why?, latencyMs, idempotencyKey }` → `{ reveal?, fidelity }` | |
| `POST /api/mimics/:id/rewind` | `{ questionId }` → `{ question, progress, previous }` | Undoes the latest answer; 409 otherwise (ADR-0036) |
| `POST /api/mimics/:id/ask` | scenario → typed question + prediction | Playground |
| `GET /api/mimics/:id/export` | → latest `mimic.json` | |
| `GET /api/mimics/:id/soul` | → SOUL.md view: sections, items, curation, the full file and both profiles' sizes | §8.3; `/persona` redirects here (308) |
| `POST /api/mimics/:id/soul` | → new `soul.v1` draft, then the view | One LLM call; rate-limited, budget-guarded |
| `PUT /api/mimics/:id/soul` | `{ rev, curation }` → view | Ignored if an equal or newer `rev` is stored; keys for replaced draft items are pruned |
| `GET /api/mimics/:id/soul.md` | `?profile=full\|core` → `SOUL.md` (text/markdown) | `/persona.md` redirects here |
| `DELETE /api/mimics/:id` | | Hard delete across D1, R2, Vectorize and KV |
| `GET/POST /api/lab/{configs,experiments,evals}` | | Admin only |

**Auth.** While the cohort is private, `/new` requires an invite code, checked against the `INVITE_CODES` secret. Invite links carry it as `?invite=CODE` on `/new` or `/`: the intake form fills the code in and hides the field, and shows it only if the server rejects the code (ADR-0026, ADR-0047). An anonymous participant cookie is set on first visit. Later, an optional email magic link (Better Auth on D1) lets people claim their mimics across devices. `/lab` sits behind Cloudflare Access, plus `ADMIN_EMAILS`.

**Limits.** Rate limit per participant and per IP. The budget guard refuses model calls for a mimic once `spend_usd` reaches its cap: `BUDGET_USD` (default $1) for configs on the standard budget, else the config's own `session.budgetUsd`. Session work (serving, shadows, refills, hypotheses) stops at `BUDGET_SESSION_SHARE` of the cap (default 0.8), keeping the rest for the mimic page: asking, teaching and SOUL.md (ADR-0035).

---

## 12. Research framework

### 12.1 Configs and experiments

- Configs are immutable and identified by hash.
- Experiments allocate each new mimic to an arm by `hash(mimicId)`, using the arm weights. A mimic's config never changes during its lifetime.
- Shadow predictors run in every arm, so predictor comparisons are within-person, on identical questions.

### 12.2 What gets compared, and how

| Variable | Online | Offline |
|---|---|---|
| Predictor (Jev vs. LLMs) | Shadows on every question | Replay |
| State builder, reflector, trait reader | — | Replay (leave-future-out) |
| Generator LLM, selector | Arms, between people | Simulation restricted to each person's answered pool (biased; use for iteration only) |
| Reveal on/off | Arms | — |

### 12.3 Eval CLI (`packages/eval`, Node)

```
mimic-eval export --env prod --out data/2026-10-01.sqlite      # wrangler d1 export → SQLite; consented only; PII scrubbed
mimic-eval replay --data … --predictor jev:typesafe/jev-1.13 --state full --checkpoints 10,20,30 --split dev
mimic-eval select --data … --selector bald --budget 5,10,20                  # pool-restricted simulation
mimic-eval import twin2k500 --path …                                         # external dataset adapter
mimic-eval report --run <id>                                                 # markdown + JSON → R2 and /lab
```

**Replay:** for each person and each checkpoint *k*, build the state from the first *k* evidence items, predict every later non-repeat item, and score.

**Metrics:**

- Accuracy (`item_acc`), log loss, Brier, and ECE (10 bins)
- Lift over baseline
- Fidelity (accuracy ÷ self-consistency)
- Across-person correlation per item
- Dispersion ratio: SD of predictions across people ÷ SD of their answers
- Cost per person, p50/p95 latency, and failure rate

Every run records the dataset hash, config hash, model snapshots and seed.

### 12.4 Data hygiene

- Export only `consent_research` mimics. Exports drop names, locations, links and URLs, and replace IDs.
- Split dev/test 80/20 by `hash(mimicId)`. Use the test split only for final reports.
- Never tune prompts on test-split people.

### 12.5 External data

Twin-2K-500 covers about 2,000 respondents, each with 500 input questions and 88 held-out questions, and is public on Hugging Face. It lets us benchmark predictors and selectors before we have users, once its items are mapped to our typed questions. Check the dataset's license and terms before importing it.

### 12.6 Population priors (P1, flagged)

Item-level answer frequencies from other consented dev-split people, used as an extra baseline and predictor feature. Off by default, behind an experiment flag, and aggregate-only.

#### 12.6a Item statistics for selection (ADR-0027)

`item_stats` holds aggregate rows per stable item (`item_key`) and per archetype (`facet | domain | type`) over
research-consented, dev-split mimics: people, answers, the population's answer entropy (items only), the
context-only baseline's error, the primary's error and normalised log loss, lift and mean latency. An hourly
`stats.refresh` job recomputes them from scratch and replaces the table, writing only groups of 5 or more people.
They rank pooled candidates in the `voi` selector (weight π, shrunk toward neutral with a prior of 20 answers) and
never enter a prompt or a state, so §3.9 holds. `pnpm eval -- select --no-population` runs the selector without them.

### 12.7 First experiments

- **E1 Predictor bake-off.** Jev vs. GPT-6 Luna vs. DeepSeek V4.1 Flash vs. GLM 5.3 Flash, run as shadows. Report log loss, accuracy, ECE, lift, $/1k predictions, and p50 latency.
- **E2 State ablation** (replay). `raw` vs. `structured` vs. `summary` vs. `full`.
- **E3 Selector** (arms). `random` vs. `entropy`, then `bald`. The primary metric is questions needed to reach fidelity ≥ 0.75, or fidelity at 20 questions.
- **E4 Reflection** (replay). Off vs. each LLM. Watch correlation and dispersion to catch stereotyping.
- **E5 Generator LLM** (arms). Luna vs. DeepSeek vs. GLM, with the same selector.

---

## 13. Cost and latency

These are estimates; verify them from `model_calls`. Per mimic, 30 questions, default config:

| Component | Estimated cost |
|---|---|
| Jev: selection, baseline, trait reads and gates | Well under $0.01 (input-only pricing, ~8K-token states) |
| Generator and reflector (GPT-6 Luna, low effort) | About $0.01–0.05 |
| Shadow predictors (3 LLMs × 30 questions × ~8K tokens) | About $0.05–0.15 |
| Search | Provider-priced; cached by query hash |

Reasoning tokens can dominate shadow-predictor cost, so cap `max_tokens` and use low effort.

**Latency.** `/next` costs about one Jev round-trip (70–500 ms) plus D1. Shadows and learning stay off the critical path.

---

## 14. Milestones (build in order)

### M0 Scaffold

- Turborepo with pnpm: `apps/web` (Next via OpenNext) and `apps/worker`; packages `core`, `adapters`, `db` and `eval`.
- wrangler configs for dev, preview and prod; D1 migrations via Drizzle; R2, KV, Queue, Vectorize and AI bindings.
- Biome or ESLint, `tsc --noEmit`, and Vitest (with `@cloudflare/vitest-pool-workers` for worker code); CI runs on every PR.

**Accept:**

- [ ] `pnpm dev` runs web and worker locally.
- [ ] `pnpm deploy:preview` deploys.
- [ ] A health route reads D1, writes R2 and enqueues a no-op job that the worker consumes.

### M1 Adapters and observability

- An OpenRouter chat client supporting JSON schema, reasoning effort and usage cost.
- A Jev client implementing §5.1, with zod response validation and Distribution mapping.
- The OpenAI-decisions stub, the Exa and Parallel adapters, and embeddings.
- `withModelCall()` logging to `model_calls` with an R2 trace on every call, plus the budget guard.

**Accept:**

- [ ] Contract tests with recorded fixtures pass offline.
- [ ] One live smoke test per provider runs behind an env flag.
- [ ] The budget guard blocks calls over the cap (test).

### M2 Core engine (no UI)

- Types, `PipelineConfig` and hashing, `ontology.v1`, `anchors.v1`, and the state builder.
- `random`, `coverage` and `entropy` selectors; Jev primary and baseline predictors; the LLM predictor.
- Scoring, fidelity, the trait reader, and the reflector with its citation guard.
- A CLI loop driven by a scripted answer file. An LLM "simulated user" is allowed for smoke tests only: simulated users are more cooperative and consistent than real people, so never report metrics from them.

**Accept:**

- [ ] Unit tests cover the scoring math, Jev mapping, config-hash stability, state-budget enforcement and the sealing rule (the state for question *t* never contains answer *t*).
- [ ] The CLI runs 30 turns end to end and writes all rows to a local SQLite database using the same Drizzle schema.

### M3 Intake and identity

- Screens `/`, `/new` and `/m/[id]/identity`; jobs `identity.search` and `identity.enrich`; fact review.

**Accept:**

- [ ] A person can confirm or skip identity.
- [ ] Declining search makes zero search calls.
- [ ] Removed facts never appear in any state (test).

### M4 Session and model panel

- `/next`, `/answers`, pool refill, learning jobs, the reveal, and fidelity.
- The model panel (headline, facets, insights, KG) and the mobile bottom sheet.
- IndexedDB cache and answer outbox.

**Accept:**

- [ ] On preview with a warm pool, answer → next is p50 ≤ 800 ms.
- [ ] Dropping the network mid-session loses no answers.
- [ ] A refresh restores the session instantly from cache.
- [ ] Keyboard-only answering works.

### M5 Shadows and lab v0

- `predict.shadow` jobs, and `/lab` with per-predictor metrics and cost/latency tables.

**Accept:**

- [ ] Every served question has 1 primary, 1 baseline and N shadow predictions.
- [ ] Primary and shadows share an identical `stateHash`; the baseline has a context-only state.

### M6 Mimic artifact and playground

- Snapshots to R2, export, hard delete, and the `/m/[id]/mimic` playground.

**Accept:**

- [ ] Delete removes every trace across D1, R2, Vectorize and KV (test).
- [ ] Export validates against the `mimic/1` schema.
- [ ] Playground answers are stored and scored as `kind = playground`.

### M7 Eval CLI

- `export`, `replay` and `report`, plus the Twin-2K-500 importer.

**Accept:**

- [ ] Replaying an export reproduces the online primary-prediction scores within tolerance, given the same config and model snapshot.
- [ ] The report appears in `/lab`.

### M8 Experiments and BALD

- Experiment allocation, the arms UI in `/lab`, the `hypotheses.refresh` job, and the BALD selector.

**Accept:**

- [ ] A two-arm experiment runs, and `/lab` shows per-arm fidelity-vs-questions curves.


### M9–M13 Categories, consent and question quality (ADR-0040 and ADRs 0042–0045)

Built on the value-of-information selector (ADR-0027). Each milestone ships with its ADR, `pnpm check` green, and the
rubric below self-scored with evidence in its PR description; the next starts only when every row the milestone can
exercise scores at least 4 of 5.

- **M9** Categories, the consent model, scope storage and scoped facets (`docs/CATEGORIES.md`, ADR-0040).
- **M10** Ontology v2 with psychological depth and opt-in sensitive facets, `reserve.v2`, `gen.v3` (concrete
  situations), `gates.v3` recalibrated on a checked-in labelled set (ADR-0042).
- **M11** Intake and session UI for categories and consent, the full enforcement sweep, leakage tests and the
  special-category export scrub (ADR-0043).
- **M12** Category balance, the trust ramp, category-aware targets and `cfg.default.v8` (ADR-0044; v7 went to the
  calibrated primary, ADR-0048).
- **M13** Offline rubric report of v8 against the M10 candidate (pinned to v6; calibration doesn't change which
  questions are asked, ADR-0048) and a two-arm experiment on real people (ADR-0045).

**Rubric (each row scored 1–5 with evidence):**

| # | Criterion | 5 looks like |
| --- | --- | --- |
| R1 | Concreteness: served adaptive questions describe a specific situation with a choice | ≥ 80% on a 30-question session, by a labelled sample of 50 generated questions and a `concrete` Jev gate calibrated on it |
| R2 | Breadth over categories and facet groups | No category above 40% or below 15% with all four selected; every facet group touched by question 20 |
| R3 | Psychological depth | ≥ 12 new facets across moral, emotional, motivational, relational and belief domains, each with poles, five labels, a research anchor and ≥ 2 reserve items |
| R4 | Sensitive coverage with every consent | Each sensitive facet reached by question 30; the sensitive gate replaced by a consented check; a respectful gate rejects demeaning wording |
| R5 | Consent and scope enforcement | Tests prove zero leakage across questions, traits, insights, facts and exports; the export scrub drops special-category evidence without research consent |
| R6 | Efficiency | Questions to sustained fidelity 0.75 and fidelity at 20 not worse than v4's `voi`; three of four categories costs ≤ 10% more questions |
| R7 | Ordering | Broad and cheap early, targeted later; no sensitive question in the first five; burden and trust ramp documented |
| R8 | UX | Intake multi-select with plain descriptions, per-area consent, changeable from the session menu; keyboard accessible; browser-tested |
| R9 | Reproducibility | Every new state field, prompt and gate replayable; `replay --mode online` passes on a new export |
| R10 | Honest reporting | Real people kept apart from scripted or simulated users in every metric |
---

## 15. Privacy and safety

- **Self-only by design.** The person attests they are modeling themselves, must confirm their own identity, and the UI offers no free search of arbitrary names.
- **Transparent facts.** Every externally sourced fact shows its source and can be removed.
- **Separate consents** for app use, web search and research use, plus the categories to ask about and one consent
  per sensitive area (ADR-0040), ticked by default at intake and each removable (ADR-0049). A special-category area
  is asked about only once the person confirms it, and any sensitive question can be skipped with "Prefer not to
  say" (ADR-0050).
- **Sensitive domains need their consent.** Enforced in code wherever facets are used (`docs/CATEGORIES.md` §5), never
  inferred from other answers or web facts, and special-category answers leave research exports unless the person
  separately consents to research on them.
- **Playground output is labeled as generated.** There is no feature to message anyone "as" a person.
- **Export and hard delete from day one.** Write a privacy note before inviting anyone outside a small cohort.

---

## 16. Risks and later work

- **Jev is a beta on an alpha endpoint.** Mitigate with the pinned version, adapter isolation, fixtures, and an LLM fallback predictor if the decisions endpoint errors (mark those predictions `fallback`).
- **Reactivity.** Showing the mimic's guess may change how people answer. `reveal` is an experiment variable, recorded on every answer.
- **Identity mistakes for common names.** Never auto-confirm; the person always picks.
- **Stated vs. revealed preferences.** Typed questions measure stated choices, and professional judgment is the weakest-covered area. P2: import real decision traces as evidence.
- **Later (P2):**
  - Per-person learned parameters (small adapters or embeddings) once enough people exist
  - Population priors (§12.6)
  - The OpenAI Decisions API as a second `DecisionProvider`
  - Free-text answers scored by a judge
  - Durable Objects, if live multi-tab sync is needed

---

## 17. Decisions to confirm (this plan assumes the defaults)

| # | Decision | Default assumed |
|---|---|---|
| 1 | Audience | Private research cohort gated by invite codes, not a public launch |
| 2 | Who can be modeled | Only yourself |
| 3 | Show the mimic's guess after each answer | Yes, recorded per answer, and available as an experiment arm |
| 4 | Answer format | Typed only (choice / yes-no / 5-point scale), plus an optional "why" |
| 5 | Database | D1 with R2, KV and Vectorize; no Postgres in v1 |
| 6 | Session length | About 30 questions (10 anchors plus ~20 adaptive, including repeats); can continue later |
| 7 | Default generator and reflector | GPT-6 Luna; the other two are tested in E5 |

---

## Appendix A — Prompt skeletons

Prompts live in `docs/prompts/{id}.md`. Changing a prompt means creating a new ID.

### A.1 Generator (`gen.v1`)

```
SYSTEM (stable)
You write short, concrete questions that reveal how one specific person makes decisions.
Each question must be one of three types:
- choice: 2–5 mutually exclusive options, roughly equally attractive
- noul: a yes/no question
- score: a 5-point ordered scale, lowest to highest
Rules:
- One idea per question. At most 30 words. Prefer concrete scenarios to abstract self-ratings.
- No "it depends" option. Never mention AI or the person's name.
- Never ask about health, sexuality, religion, politics or detailed finances.
- Ground professional scenarios in the person's occupation.
Return JSON only, matching the schema.

ONTOLOGY (stable): {facet id, name, low pole, high pole}[]

TASK (variable)
Target facets: {targets}
Domain quota: {core: n, casual: n, professional: n}
Person context: {identity facts}, {trait summary}
Recently asked (don't repeat these): {last 10 prompts}
Write {n} questions.
```

### A.2 Reflector (`reflect.v1`)

```
SYSTEM
You analyze one person's answers and write insights that are specific to them and supported by their answers.
- Every insight must cite the seq numbers of the answers that support it. No citation, no insight.
- Describe behavior, not identity labels. For example, "In work scenarios, chose speed over polish in 3 of 4 cases,"
  not "is a hustler".
- Don't infer demographics, politics, religion or health.
- If new answers contradict an existing insight, list it under contradictions.
Return JSON: { insights: [{ text, facetIds, evidenceSeqs, confidence }], facts: [{ predicate, object, evidenceSeqs }],
               contradictions: [{ insightId, evidenceSeqs }] }

INPUT: {existing insights}, {new evidence}, {relevant earlier evidence}
```

### A.3 LLM predictor (`predict.v1`)

```
SYSTEM
Estimate the probability that the person described below would choose each option.
Base your estimate only on the information given. If the evidence is weak, spread the probability.
Return JSON: { "probs": [{ "key": string, "p": number }] } covering every option key.

STATE: {rendered PersonState}
QUESTION: {prompt}
OPTIONS: {key: label}
```

### A.4 Persona hypotheses (`hyp.v1`, BALD)

```
Write {k} distinct one-paragraph readings of this person. Each must be consistent with every listed answer,
but the readings should differ on the facets with the lowest certainty: {facets}.
Return JSON: [{ id, text, leanings: { facetId: "low" | "mid" | "high" } }]
```

---

## Appendix B — Jev request examples

### B.1 Predict an answer (choice)

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "identity": { "occupation": "Software engineer", "location": "San Francisco, US" },
    "traits": [{ "facet": "speed_vs_quality", "mean": 0.62, "confidence": 0.4 }],
    "evidence": [{ "seq": 4, "q": "A deadline slips. What do you cut first?", "answer": "Polish" }]
  },
  "questions": {
    "q_01JABC": {
      "type": "choice",
      "instructions": "Predict how the person described in the state would answer this question, based only on the state: \"A teammate ships a quick fix you think is fragile. What do you do?\"",
      "criteria": {
        "a": "The person would choose: Approve it and open a follow-up ticket",
        "b": "The person would choose: Ask for changes before merging",
        "c": "The person would choose: Rewrite it yourself"
      }
    }
  }
}
```

### B.2 Read a trait (score)

```json
"risk_tolerance": {
  "type": "score",
  "instructions": "Based only on the state, where does this person fall on risk tolerance in their decisions?",
  "criteria": ["Strongly avoids risk", "Leans cautious", "Balanced", "Leans toward risk", "Strongly seeks risk"]
}
```

### B.3 Quality gate (noul)

Each gate request uses one candidate as its state, `{ "question": { prompt, type, options } }`, and asks all four gates in one call.

```json
"ambiguous": {
  "type": "noul",
  "instructions": "Could the same person reasonably give different answers depending on how they read this question?",
  "criteria": { "true": "The wording allows more than one reasonable reading.", "false": "The wording has one clear reading." }
}
```

---

## Appendix C — Ontology v1 facets (`docs/ontology/v1.json`)

Ontology v2 (ADR-0042) keeps every v1 facet below word for word, regroups them into ten groups that each sit in one
category, and adds 34 facets, 11 of them sensitive. Its table and the research anchor of every facet are generated
into `docs/ontology/v2.json` and `docs/ontology/v2.sources.md`.

Each facet has an ID, a group, a low pole, a high pole, and 5 ordered labels for trait reads (write these from the poles, as in B.2). Occupation-specific facets are added per mimic (§9.8).

| Group | Facet ID | Low pole → high pole |
|---|---|---|
| Personality | `openness` | Prefers the familiar → seeks novelty and ideas |
| Personality | `conscientiousness` | Flexible, spontaneous → organized, disciplined |
| Personality | `extraversion` | Reserved → outgoing |
| Personality | `agreeableness` | Challenging → accommodating |
| Personality | `emotional_stability` | Easily stressed → even-keeled |
| Values | `openness_to_change` | Tradition and stability → independence and stimulation |
| Values | `self_enhancement` | Modest ambitions → achievement and status |
| Values | `conservation` | Questions rules → values order and security |
| Values | `self_transcendence` | Focus on self → focus on others' welfare |
| Decisions | `risk_tolerance` | Avoids risk → seeks risk |
| Decisions | `patience` | Wants it now → waits for more later |
| Decisions | `loss_aversion` | Losses and gains weigh the same → losses loom larger |
| Decisions | `ambiguity_tolerance` | Needs certainty → comfortable with unknowns |
| Decisions | `maximizing` | Good enough is fine → must find the best |
| Decisions | `deliberation` | Goes with gut → thinks it through |
| Social | `trust` | Wary of others → trusts by default |
| Social | `reciprocity` | Transactional → strongly fair and reciprocal |
| Social | `conformity` | Goes own way → follows the group |
| Social | `conflict_directness` | Avoids conflict → addresses it head-on |
| Work | `autonomy` | Prefers direction → prefers full ownership |
| Work | `planning` | Improvises → plans ahead |
| Work | `detail_orientation` | Big picture → details |
| Work | `collaboration` | Works alone → works with others |
| Work | `leadership_drive` | Prefers to contribute → prefers to lead |
| Work | `speed_vs_quality` | Polish first → ship fast |
| Everyday | `routine` | Spontaneous days → structured routines |
| Everyday | `social_energy` | Recharges alone → recharges with people |
| Everyday | `spending_style` | Frugal → indulgent |
| Everyday | `taste_novelty` | Sticks with favorites → tries new things |
| Communication | `directness` | Diplomatic, indirect → blunt |
| Communication | `formality` | Casual → formal |
| Communication | `verbosity` | Brief → detailed |
| Communication | `humor` | Serious → playful |
