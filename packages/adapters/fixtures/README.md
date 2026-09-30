# Adapter fixtures

Recorded from one real call per provider on 2026-09-30, then used by the offline contract tests.

| File | Source |
| --- | --- |
| `jev-decisions.json` | Live `POST /api/alpha/decisions` (`typesafe/jev-1.13`) with one choice, one noul and one score question. |
| `openrouter-chat-json-schema.json` | Live chat completion, `deepseek/deepseek-v4.1-flash` routed to Wafer with a strict JSON schema. |
| `openrouter-embeddings.json` | Live `baai/bge-base-en-v1.5` embeddings; vectors truncated to 8 dims to keep the file small. |
| `exa-people-search.json` | Live Exa `category: "people"` search envelope; the people in it were replaced with fictional ones. |
| `exa-contents.json` | Live Exa `/contents` on a LinkedIn profile URL (the intake link lookup); the person was replaced with a fictional one. |
| `parallel-task-*.json` | Built from Parallel's published OpenAPI schema: `api.parallel.ai` is blocked by this environment's egress policy (ADR-0009). |
