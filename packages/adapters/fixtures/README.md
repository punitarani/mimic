# Adapter fixtures

Recorded from one real call per provider on 2026-09-30, then used by the offline contract tests.

| File | Source |
| --- | --- |
| `jev-decisions.json` | Live `POST /api/alpha/decisions` (`typesafe/jev-1.13`) with one choice, one noul and one score question. |
| `span-decisions.asked.json`, `span-decisions.request.json`, `span-decisions.json` | Live `POST /api/alpha/decisions` (`respan/span-01-20260925`, 2026-09-30): one choice, one noul and one score question as Jev is asked them (`.asked`), the request `planDecision` sends span-01 for them (`.request`: state as JSON text, each choice and score option as its own yes/no question), and span-01's answer. |
| `span-decisions-object-state-400.json`, `span-decisions-choice-400.json` | Live: span-01 refuses a JSON-object state and any non-`noul` question with HTTP 400 (the limits `decisionModelLimits` encodes; ADR-0051). |
| `span-decisions-provider-blocked.json` | Live: the 404 OpenRouter returns while the account's allowed providers exclude Respan. |
| `openrouter-chat-json-schema.json` | Live chat completion, `deepseek/deepseek-v4.1-flash` routed to Wafer with a strict JSON schema. |
| `openrouter-embeddings.json` | Live `baai/bge-base-en-v1.5` embeddings; vectors truncated to 8 dims to keep the file small. |
| `exa-people-search.json` | Live Exa `category: "people"` search envelope; the people in it were replaced with fictional ones. |
| `exa-contents.json` | Live Exa `/contents` on a LinkedIn profile URL (the intake link lookup and enrichment); the person was replaced with a fictional one. |
| `exa-contents-page.json`, `exa-contents-summary.json` | Live Exa `/contents` on a personal site (no person entity), then its schema summary for enrichment; the person was replaced with a fictional one. |
| `parallel-task-*.json` | Built from Parallel's published OpenAPI schema: `api.parallel.ai` is blocked by this environment's egress policy (ADR-0009). |
