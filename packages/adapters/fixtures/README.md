# Adapter fixtures

Recorded from one real call per provider on 2026-09-30, then used by the offline contract tests.

| File | Source |
| --- | --- |
| `jev-decisions.json` | Live `POST /api/alpha/decisions` (`typesafe/jev-1.13`) with one choice, one noul and one score question. |
| `span-decisions-provider-blocked.json` | Live `POST /api/alpha/decisions` (`respan/span-01-20260925`, 2026-09-30): the 404 OpenRouter returns while the account's allowed providers exclude Respan (ADR-0050). |
| `span-decisions.json` | **Constructed**, not recorded: span-01 in the Decisions API response shape the model page documents (identical to Jev's), because the account could not reach Respan yet. Re-record it from one live call once Respan is allowed (docs/CHALLENGER.md). |
| `openrouter-chat-json-schema.json` | Live chat completion, `deepseek/deepseek-v4.1-flash` routed to Wafer with a strict JSON schema. |
| `openrouter-embeddings.json` | Live `baai/bge-base-en-v1.5` embeddings; vectors truncated to 8 dims to keep the file small. |
| `exa-people-search.json` | Live Exa `category: "people"` search envelope; the people in it were replaced with fictional ones. |
| `exa-contents.json` | Live Exa `/contents` on a LinkedIn profile URL (the intake link lookup and enrichment); the person was replaced with a fictional one. |
| `exa-contents-page.json`, `exa-contents-summary.json` | Live Exa `/contents` on a personal site (no person entity), then its schema summary for enrichment; the person was replaced with a fictional one. |
| `parallel-task-*.json` | Built from Parallel's published OpenAPI schema: `api.parallel.ai` is blocked by this environment's egress policy (ADR-0009). |
