# Requirements coverage and remaining release gates

The supplied product definition spans v0.1, v0.2, v1.0, and later capability tracks. This commit implements the first local runtime slice. It is an initial development release, not a claim that the full PRD or every v0.1 acceptance gate is complete.

## Implemented and locally tested

| Requirement area | Delivered behavior |
| --- | --- |
| Core API | TypeScript ESM, createGateway, canonical version 1, normalized results/errors |
| Model ownership | Arbitrary user aliases, direct provider/model calls, explicit bounded fallback chains |
| Provider adapters | OpenAI Chat Completions, generic compatible endpoints, Anthropic Messages, Gemini GenerateContent |
| Operations | Generation, lazy streams, manual tools, native schema mapping, supported embeddings |
| Local controls | Concurrency, sliding RPM/TPM, reservation/reconciliation, bounded FIFO queues, queue/total timeout, cancellation |
| Quota scopes | Atomic global/provider/alias/declared-tenant/operation admission |
| Reliability | Typed permanent/transient handling, jitter, Retry-After, global attempt cap, no partial-stream restart |
| Validation | Raw JSON Schema subset, custom parser, real Zod and Valibot Standard Schema tests and type inference |
| Logging | Metadata defaults, explicit full serialized wire inspection, secret field/header/query redaction, bounded payloads |
| Observability | Request/attempt spans and lifecycle events, asynchronous bounded export, optional Langfuse adapter, health counters |
| Usage and prices | Known/unknown usage distinction, application prices, successful and observed-attempt cost |
| CLI | init, doctor, config, providers, models, explicit test, inspect |
| Developer tooling | Mock transport, shared provider contract tests, virtual-clock scheduler tests, API declarations/docs, local benchmark, Node CI |
| Lifecycle | flush, bounded grace period, cancellation on close |

## v0.1 gates still requiring work or external validation

| Gate | Current limitation or required verification |
| --- | --- |
| Real provider calls | No API keys were supplied; tests inject HTTP/SSE fixtures rather than incur real charges |
| Live Langfuse | Mapping is implemented and tested with injected transport; credentials and real ingestion verification are pending |
| Full provider parity | Model-specific thinking signatures, citations, all media categories, and uncommon errors are not normalized yet |
| Structured output breadth | Native schema capability depends on the model; raw schema validator supports a fail-closed subset, not a complete JSON Schema draft |
| Separate deadline hierarchy | Queue and total deadlines exist; connection, attempt, first-token, and idle-stream deadlines are pending |
| OpenTelemetry | Events align with trace/span concepts; actual OTel SDK/OTLP exporter and automatic context propagation are pending |
| Configuration precedence | Gateway/alias/request generation defaults implemented; independent provider/operation default layers remain pending |
| Governance | Configured tenant quota pools exist; provider/model allowlists and general policy hooks remain pending |
| Advanced logging | No content-aware redaction callback, hashing policy, or deterministic sampling yet |
| Runtime portability | Local Node 24/Linux test run; Node 22/24 CI configured; Bun/Deno/edge/Lambda execution is not validated |
| npm publication | Name ownership, license, release provenance, and publication are unresolved; package is buildable and packable locally |

## v0.2 production controls

- Distributed quota coordinator, priority classes, fair scheduling, adaptive provider rate feedback.
- Circuit breakers, exact-cache contract/backend, stampede protection, prompt-cache normalization.
- Schema repair, bounded tool execution helper, application policy hooks, hierarchical monetary budgets.
- Native batch/flex/offline operation adapters.
- Replay persistence, shadow execution, deterministic experiments, evaluator hooks.
- Metrics exporters, additional logger adapters, configuration migration.

## v1.0 and later

- Stable public extension/plugin compatibility contract and canonical schema migration policy.
- Tested edge/Bun/Deno guarantees and hardened multitenant configuration reload.
- Additional providers such as Azure, Bedrock, and Vertex.
- Security release process, SBOM/provenance, sustained benchmark and fault-test gates.
- Image/audio/video/file operation packages, optional HTTP gateway, advanced storage and semantic cache.

## Deliberately outside the product

No automatic best/fast/smart model selection, agent planning, RAG pipeline, model leaderboard, mandatory telemetry service, or silent configuration edits. The implementation does not inspect or modify Docker services.
