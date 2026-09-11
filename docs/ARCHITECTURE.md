# Architecture and contracts

## Execution pipeline

`createGateway` captures provider descriptors, aliases, policies, and limits without network I/O. Each operation resolves a route, validates supported features and schema, prepares the provider request, atomically acquires quota pools, emits sanitized request metadata, sends one serialized payload through injected or global `fetch`, normalizes the response, reconciles tokens, validates output and tool arguments, calculates known cost, and emits completion events.

Adapters are independently imported subpaths. The core uses Web APIs and has no filesystem or Node built-in imports. The CLI, examples, and benchmarks use Node APIs separately. Provider adapters must follow schema contract version `1` and must respond to cancellation.

## Source map

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Canonical request, result, stream, adapter, schema, telemetry, and configuration contracts |
| `src/gateway.ts` | Route resolution, execution lifecycle, reliability, validation, accounting, and shutdown |
| `src/scheduler.ts` | Atomic admission across local quota pools with injectable clock |
| `src/errors.ts` | Stable error codes and safe error normalization |
| `src/validation.ts` | Standard Schema, custom adapters, and strict raw JSON Schema subset |
| `src/telemetry.ts` | Redaction, payload policy, bounded buffered exporters |
| `src/providers/` | OpenAI Chat Completions, OpenAI-compatible, Anthropic Messages, Gemini GenerateContent |
| `src/telemetry/` | Optional console and Langfuse ingestion exporters |
| `src/testing.ts` | Scriptable in-memory HTTP adapter |
| `cli/index.mjs` | Non-destructive initializer and diagnostics |

## Configuration

Generation parameter precedence is: built-in defaults, gateway `defaults`, alias `defaults`, request. Built-in `maxOutputTokens` is 1024 and is sent to the provider so token reservations correspond to an explicit output cap. Request timeout can tighten but cannot exceed the gateway total deadline. Quotas cannot be overridden by a request.

| Setting | Default |
| --- | --- |
| Global concurrency | 20 |
| RPM / TPM | Unlimited until configured |
| Queue size | 1000 |
| Queue timeout | 30 seconds |
| Sliding window | 60 seconds |
| Total request timeout | 30 seconds including queue, retries, and validation |
| Attempts | 3 total across retries and fallbacks |
| Retry delay | Full jitter, 250 ms exponential base, 10 second cap |
| Payload logging | Metadata; no default sink |
| Per-event payload budget | 16 KiB conservative redaction budget |
| Export queue | 1000 events |
| Export batch | 100 events |
| Export interval | 1 second |
| Export timeout | 2 seconds per batch |
| Response/assembled stream bound | 4 MiB |
| Concurrent assembled tool calls | 128 |

Provider options are namespaced by adapter name (`openai`, `openai-compatible`, `anthropic`, `gemini`). Unknown fields pass through. Canonical fields take precedence over contradictory provider options so aliases, stream mode, and token caps remain authoritative. For Gemini, generation-specific provider options belong in `providerOptions.gemini.generationConfig`. Supply custom `headers`, `query`, `baseURL`, or `fetch` on the adapter. Credential callbacks resolve afresh on each attempt.

## Scheduling

A single FIFO queue atomically reserves all applicable pools. It never consumes a global request allowance while waiting for another pool. All limits are per gateway instance, not shared across processes.

```ts
scopedLimits: {
  providers: { google: { concurrency: 10, rpm: 300 } },
  aliases: { main_model: { tpm: 100000 } },
  tenants: { customer_a: { concurrency: 2, rpm: 20 } },
  operations: { embed: { concurrency: 4 } },
}
```

Tenant scope uses `request.metadata.tenantId`; derive it from authenticated application context. Only declared tenant scopes have separate pools. Global limits still apply to all calls. FIFO scheduling can cause head-of-line blocking; priority and fairness belong to the production-controls phase.

Input estimation uses UTF-8 byte count of serialized canonical input plus schemas and tool definitions. This deliberately overestimates ordinary text but is not a model tokenizer and cannot guarantee a bound on image/provider-specific tokenization. Set `estimatedInputTokens` explicitly for known inputs. Estimated input plus the output cap is reserved before each transport attempt. Actual total usage refunds or increases the reservation. If usage is missing or a request fails/cancels, the reservation remains charged conservatively until window expiry. RPM is charged per admitted attempt, including retries.

An overrun is charged after it is learned and blocks subsequent admission; no local scheduler can retroactively prevent a provider-reported overrun. Reservations above a configured TPM limit fail immediately. Queue cancellation never consumes quotas.

## Reliability and streams

401/403, other permanent 4xx, schema errors, configuration failures, content-policy errors, and cancellation do not retry. 408, 429, transport failures classified as `TypeError`, and 5xx can retry. Provider error body text is deliberately excluded from public errors. HTTP 413 maps to `CONTEXT_LENGTH`; provider-specific context errors reported as HTTP 400 remain permanent `PROVIDER` errors.

Numeric and HTTP-date `Retry-After` are honored. A delay longer than the remaining total request deadline expires the request instead of retrying early. Explicit fallback chains are traversed in declared depth-first order within the same total attempt cap. Permanent authentication or policy failures cannot be made retryable accidentally by listing them in `fallbackOn`.

The initial implementation exposes queue and total deadlines. Separate connection, attempt, first-token, and idle-stream timeout knobs remain pending. Retries are conservatively disabled once any stream event is visible. Partial-stream errors carry `partialOutput: true` and attempt history, but omit the partial prompt/response from the error object. Consumers already have yielded content.

Stream parsing handles incremental UTF-8, CRLF, multiline SSE data, and fragmented tool arguments. The SSE parser bounds individual frames to 1 MiB. The assembled response is bounded by `maxResponseBytes`. The runtime pulls with consumer demand rather than running an unbounded background pump. Stream time includes consumer backpressure; the total deadline still applies. Always finish iteration, break it, or call `cancel()`.

Transport cancellation is cooperative. Native `fetch` and included stream parsers honor AbortSignal. A custom transport that ignores it may continue remote work even after the local deadline; LLMX stops awaiting it and reports failure.

## Validation and tools

Supported raw JSON Schema keywords: `$schema`, `$id`, `title`, `description`, `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, and boolean schemas. Unsupported keywords, including `$ref`, `format`, and `pattern`, fail before transport. Use a custom validator for complete draft support. Provider schema acceptance can differ from local validation; provider incompatibility returns a permanent error rather than silently removing constraints.

Standard Schema supplies validation and inferred TypeScript output. It does not necessarily supply JSON Schema; pass `jsonSchema` separately to enable native structured output. For raw `output` schemas, the same schema is sent to the provider and validated locally. `jsonSchema` by itself configures native output without claiming local validation. A custom `{ parse(value), jsonSchema? }` adapter can use any validation library.

Registered tool arguments are validated before a final result is returned. Streamed argument fragments remain unvalidated until completion. Tool execution stays in application code. Gemini tool-result messages require both `toolCallId` and `name` for correct function-response mapping. Extended thinking signatures and provider-specific tool state need additional adapter work before round-tripping those workflows.

## Privacy and tracing

Default events contain IDs, route, status, timings, usage, configured attribution metadata, and cost. Prompt, response, reasoning, tools, raw bodies, and wire bodies are excluded unless `logging.payloads` is `full`. Authentication headers, common secret field names, and secret query parameters are redacted before sinks/exporters. No raw provider errors are attached as Error causes.

Custom redaction paths are relative to event attributes, support one-segment `*`, and are exact-depth matches. Explicit full-mode inspection is still sensitive: field redaction cannot detect every secret embedded inside arbitrary natural-language strings. Configure application redaction paths and avoid putting credentials inside prompts. Oversized records are truncated and therefore are not lossless replay records. Runtime `inspectConfig()` omits provider connection secrets entirely.

Events have a 32-character generated trace ID, request ID, request span ID, and per-attempt span IDs. Callers may pass an explicit `traceId`. The format is OpenTelemetry-aligned, but this release does not provide an OpenTelemetry SDK exporter, automatic async context propagation, or OTLP transport. Exporter implementations can map these events into existing telemetry systems. Langfuse uses its public ingestion API with trace and generation records; real service integration remains a release gate.

Exporters are bounded, asynchronous, and fail-open. `health()` exposes drops and failures. Logging callbacks are synchronous application hooks and must be fast. Do not treat an untrusted logger/exporter as a security boundary.

## Cost

Prices are user-owned and keyed by `connection/model`:

```ts
prices: {
  'google/your-model': { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.1, currency: 'USD' },
}
```

Cost is returned only when the required provider token counts and price are known. It is not inferred from an estimate. `result.cost` covers the successful attempt; sum known `attempts[].cost` to include other observed charges. Failed attempts with missing usage have unknown cost, not zero cost. Gemini reasoning tokens are included in normalized output usage; Anthropic cache-read/cache-write tokens are included in normalized input totals. Distinct cache-write surcharges, media pricing, and detailed attribution aggregates remain pending; do not treat these values as billing statements.

## Runtime support and packaging

ESM only, Node >=22. CommonJS applications can use dynamic `import()`. No dual CommonJS build is provided. All runtime imports are standards-based, but only the stated test matrix is supported. Edge compatibility is an architectural goal until tested. Package exports include the core, provider subpaths, telemetry subpaths, and mock adapter. Generated declaration files and source maps ship in the tarball. No automatic npm publish workflow is configured.

## Provider references

Wire formats were checked against the official documentation, accessed during implementation:

- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Gemini GenerateContent](https://ai.google.dev/api/generate-content)
- [Langfuse public API](https://langfuse.com/docs/api-and-data-platform/features/public-api)

Model-specific capability support and live account behavior must be verified against the target model before deployment.
