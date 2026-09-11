# Product requirements

Extracted from the user-supplied LLM_API_Runtime_Product_Requirements(2).docx. Original wording preserved as plain text; tables follow the body.

PRODUCT REQUIREMENTS

LLM API Runtime Product Requirements

Comprehensive feature specification and phased scope

Product
TypeScript and Node package for controlled LLM API execution

Document status
Product definition

Version
1.0

Date
11 September 2026



Core product boundary

The package executes, controls, validates, observes, and debugs model API interactions. It does not choose models on the developer's behalf or become an agent and RAG framework.

Executive Summary

This product is a lightweight TypeScript runtime that sits inside an application and governs every LLM API call. A developer configures providers, model aliases, limits, validation, reliability, logging, and telemetry once. Application code then uses a small, consistent API for generation, streaming, tools, structured output, embeddings, and later media or batch operations.

The package must remain neutral about which model is best. It resolves aliases supplied by the application, sends requests through provider adapters, and applies the developer's explicit policies. It must expose the exact sanitized wire payload sent to a provider, normalize responses and errors, enforce RPM, TPM, concurrency, and budget limits, and add negligible overhead relative to the network call.

The first release should focus on the local library experience. Optional adapters may add Langfuse, OpenTelemetry, Redis, caches, or provider SDK integrations without making any of them mandatory. The package should support direct model identifiers as well as aliases, and new provider model releases should work without requiring a package update when the wire API remains compatible.

Product Outcome

One import and one configuration file control all LLM calls in a TypeScript codebase.

The same request API works across supported providers without hiding provider specific capabilities.

Every call can be scheduled, retried, traced, logged, costed, validated, cancelled, and reproduced through a common execution pipeline.

The core remains small, fast, portable, and free of infrastructure requirements.

Document Scope

This specification defines the full feature set, the required product behavior, the boundary between the core and optional adapters, the first public release, later phases, acceptance criteria, and features that are deliberately excluded.

Contents

1 Product Definition

2 Product Principles and Locked Decisions

3 Users and Use Cases

4 Core Runtime Architecture

5 Complete Feature Requirements

6 Configuration and Developer Experience

7 Provider and Model Handling

8 Execution Scheduling and Reliability

9 Validation Logging and Observability

10 Cost Security and Governance

11 Performance Portability and Operations

12 Example Product Interface

13 Release Plan

14 Acceptance Criteria

15 Excluded Scope

16 Open Product Decisions

1 Product Definition

Product Category

The product is an in process LLM API runtime distributed as npm packages. It is loaded by the application and controls outbound model calls without requiring a separate proxy or hosted control plane. An optional gateway service may be considered later, but it is not required for the core value proposition.

Problem Statement

Production applications currently assemble provider clients, custom retries, rate limiters, schema parsers, loggers, tracing SDKs, cost calculators, and fallback logic separately. The resulting behavior differs between services, exact provider payloads are hard to inspect, and quota or budget controls are often applied after failures occur. The product should replace this scattered code with one predictable runtime while allowing each application to retain control over models and provider specific features.

Primary Promise

A developer should be able to install the package, create one gateway file, declare providers and aliases, and call the runtime from anywhere in the application. The configured controls should apply automatically, with explicit per request overrides where permitted.

Success Measures

2 Product Principles and Locked Decisions

Developer Owned Model Selection

The runtime executes choices made by the application. It does not maintain an opinionated ranking of models.

DEC 01  Aliases are indirection only  An alias maps to a provider connection and model string supplied by the user. Names such as main_model or eval_model have no built in meaning.

DEC 02  Direct model identifiers remain valid  Every operation accepts a configured alias or an explicit provider and model pair.

DEC 03  No package model catalogue  The core does not require a release when a provider adds a model whose existing API contract is compatible.

DEC 04  No automatic complexity routing  The runtime does not infer that a prompt is easy or hard and switch models unless the developer installs or writes an explicit routing plugin.

Portable and Optional Integrations

The core should contain only the execution primitives needed on every call.

DEC 05  No mandatory validator  The core consumes Standard Schema Standard JSON Schema raw JSON Schema or a custom validator interface. Zod Valibot ArkType and similar libraries remain optional.

DEC 06  No mandatory telemetry backend  Tracing uses an internal OpenTelemetry aligned contract. Langfuse console and custom exporters are adapters.

DEC 07  No mandatory distributed infrastructure  Memory backed scheduling caching and queues work by default. Redis or another coordinator is optional.

DEC 08  Provider escape hatch  Normalized fields cover common behavior while providerOptions passes through new or provider specific settings.

Performance and Transparency

DEC 09  Compile once execute many  The gateway validates configuration compiles redaction rules initializes adapters and builds scheduling state during startup.

DEC 10  Asynchronous telemetry  Export and log transport must not delay a completed provider response except when the user explicitly selects a synchronous compliance sink.

DEC 11  Wire level inspection  The adapter exposes the exact payload and endpoint prepared for the provider after sanitization and before transport.

DEC 12  No hidden calls  Retries fallbacks schema repairs shadow requests and cache decisions appear in traces and cost accounting.

3 Users and Use Cases

Representative Use Cases

A web service sends streamed chat responses through Gemini and falls back to OpenAI only for retryable failures.

A document extraction service validates every response against a Standard Schema compatible validator and runs one visible repair attempt when validation fails.

A batch pipeline reserves estimated tokens before execution and stays within a shared provider TPM allocation.

A platform team sends OpenTelemetry traces to its existing collector and Langfuse events through an optional exporter.

A developer replays a failed production request against another model using a sanitized trace record.

A multitenant service applies per tenant concurrency and daily budget limits while also respecting the provider account quota.

4 Core Runtime Architecture

Every subsystem should operate on a versioned canonical request and response. Only provider adapters understand provider specific wire formats.

1.  Resolve the requested alias or direct provider and model pair.

2.  Validate configuration request fields and required capabilities.

3.  Apply allowlists budgets and other configured policies.

4.  Estimate tokens and acquire concurrency RPM and TPM capacity.

5.  Check an enabled cache and record the decision.

6.  Transform the canonical request into the exact provider wire request.

7.  Create trace context and emit a sanitized outbound request event.

8.  Execute the provider call with timeout cancellation retry and fallback rules.

9.  Normalize the response stream usage stop reason and provider metadata.

10.  Parse and validate structured output when requested.

11.  Reconcile reserved tokens with actual usage and calculate cost.

12.  Export logs traces and metrics asynchronously and return the normalized result.

Core Modules

5 Complete Feature Requirements

Priorities use Must for the first public release, Should for the next production phase, and Later for advanced or enterprise work. Detailed behavior appears in the following sections.

6 Configuration and Developer Experience

Single Gateway Configuration

The normal integration should produce one application owned file such as src/lib/llm.ts.

CFG 01  One initialization entry point  createGateway or defineGateway accepts providers aliases scheduler reliability telemetry validation logging cost and plugin settings.

CFG 02  Startup validation  Unknown providers duplicate aliases invalid limits conflicting policies and unavailable optional adapters fail before the first request.

CFG 03  Environment references  Secrets can be read from environment variables or user supplied secret providers. The package never writes API keys into generated source files.

CFG 04  Layered configuration  Package defaults may be overridden by gateway model alias operation and individual request settings according to a documented precedence order.

CFG 05  Immutable runtime snapshot  The gateway compiles a read only configuration at startup so each request does not repeatedly parse configuration.

CFG 06  Configuration introspection  The developer can print or inspect the effective configuration with secrets and sensitive values redacted.

CFG 07  Controlled reload  A later option may swap validated configuration atomically. In flight calls retain the snapshot under which they started.

Plug and Play Integration

DX 01  Initializer  A CLI command detects the package manager runtime module system TypeScript settings and installed provider or validation libraries before generating a minimal gateway file.

DX 02  Non destructive scan  The initializer may scan dependency manifests imports and common LLM client call patterns. It reports findings and requests confirmation before editing source files.

DX 03  Incremental adoption  The package supports one route or service at a time. Existing provider clients can coexist during migration.

DX 04  Copy ready examples  Documentation includes minimal generation streaming tools structured output fallback and tracing examples.

DX 05  Tree shakeable imports  Provider exporters validators caches and distributed schedulers load only when imported.

Configuration Precedence

1.  Core defaults provide safe behavior such as timeouts and metadata only logging.

2.  Gateway configuration applies to every request.

3.  Provider connection settings apply to calls through that connection.

4.  Alias settings add explicit fallback or limit policies for that alias.

5.  Operation settings apply to generate stream embed or batch behavior.

6.  Per request settings override only fields marked as overridable by the gateway.

7 Provider and Model Handling

Provider Connections

PRV 01  Named connections  Applications can configure multiple connections to the same provider for separate projects regions accounts or base URLs.

PRV 02  Initial adapters  The first release supports OpenAI Anthropic Gemini and generic OpenAI compatible endpoints.

PRV 03  Custom endpoints  Connection options include base URL headers query parameters organization project API version proxy transport and timeout where relevant.

PRV 04  Custom transport  Users can inject fetch or a transport wrapper for tests proxies service meshes custom certificates or runtime compatibility.

PRV 05  Credential callback  A connection may resolve short lived credentials for every attempt without exposing them in logs or trace attributes.

PRV 06  Health state  Adapters expose availability circuit state last error and observed rate limit metadata without making probe calls by default.

Model Aliases

MOD 01  User defined alias  An alias maps an application name to a connection and exact model string.

MOD 02  Direct bypass  A request may use a direct connection and model string without registering an alias.

MOD 03  No semantic meaning  The runtime treats main_model eval_model or any other alias as opaque text.

MOD 04  Alias policy  An alias may define explicit fallback chains default parameters limits or metadata without changing the model selection philosophy.

MOD 05  Environment controlled mapping  Applications may load model strings from environment variables so model changes do not require source changes or package releases.

MOD 06  Capability declaration  Adapters declare stable API capabilities and applications may optionally declare model specific capabilities. Unknown capabilities cause a clear warning or error based on strictness.

Provider Compatibility

PRV 07  Common normalized fields  Messages sampling stop sequences token limits metadata response format tools and stream options use canonical names.

PRV 08  Provider options  Provider specific fields pass through under a namespaced object and remain visible in the wire payload inspector.

PRV 09  Forward compatibility  OpenAI compatible adapters permit unknown provider fields when configured so new API options are not blocked by the core type surface.

PRV 10  Unsupported feature handling  The runtime rejects unsupported requested operations before transport when capability information is available.

Core LLM Operations

Streaming Requirements

STR 01  Canonical events  Streams normalize text deltas reasoning deltas tool calls citations usage finish errors and provider metadata into typed events.

STR 02  Final result helper  Consumers may iterate events obtain only text or await a fully assembled final result.

STR 03  Backpressure  The runtime does not buffer an unbounded number of stream events when a consumer is slow.

STR 04  Cancellation  AbortSignal closes the provider connection releases scheduler capacity and marks the trace as cancelled.

STR 05  Partial tool arguments  Adapters assemble fragmented tool argument JSON safely and expose partial events only when requested.

STR 06  Stream error semantics  An error after partial output includes emitted content attempt history and whether fallback is safe. The runtime never silently restarts a user visible stream.

8 Execution Scheduling and Reliability

Scheduler

The scheduler controls admission before a provider request begins. It must understand request count token weight and active concurrency at the same time.

SCH 01  Concurrency limit  Enforce global provider connection alias tenant and operation concurrency caps.

SCH 02  RPM limit  Use a sliding window or token bucket algorithm with deterministic behavior and burst configuration.

SCH 03  TPM limit  Estimate input plus configured maximum output reserve capacity before execution and reconcile against actual usage afterward.

SCH 04  Queue timeout  A request may expire while waiting without consuming provider capacity.

SCH 05  Queue cancellation  Cancelled jobs leave the queue immediately and release any provisional reservation.

SCH 06  Priority classes  Configured priority affects queue order while aging prevents starvation.

SCH 07  Tenant fairness  Weighted fair queuing prevents one tenant or feature from consuming all shared capacity.

SCH 08  Bounded queue  The runtime rejects excess work with a typed overload error instead of consuming unbounded memory.

SCH 09  Distributed mode  An optional coordinator such as Redis enforces shared limits across processes and pods using atomic operations.

SCH 10  Rate limit feedback  The adapter records provider rate limit headers and may update effective capacity when adaptive mode is enabled.

Token Reservation Behavior

reservedTokens = estimatedInputTokens + maximumOutputTokens
refundTokens   = max(0, reservedTokens - actualTotalTokens)
overrunTokens  = max(0, actualTotalTokens - reservedTokens)

Token estimation is provider and model aware when a tokenizer adapter exists. Otherwise the runtime uses a documented conservative estimator. Actual provider usage is authoritative. Missing usage remains visible as estimated rather than being presented as exact.

Reliability Controls

REL 01  Timeout hierarchy  Support queue connect first token idle stream total attempt and total request deadlines.

REL 02  Typed retry policy  Retry decisions use normalized error classes HTTP status provider codes idempotency and whether output has already been exposed.

REL 03  Backoff and jitter  Exponential or provider directed delay includes jitter and honors Retry After within configured maximums.

REL 04  Explicit fallback  Fallback occurs only through a user configured ordered or weighted route and only for eligible failures.

REL 05  Attempt budget  A maximum attempt count and total elapsed deadline cover retries repairs and fallbacks to prevent runaway calls.

REL 06  Circuit breaker  Repeated transient failures open a per connection circuit with half open probes and observable state.

REL 07  Idempotency support  Provider idempotency keys or application request keys are propagated where supported. The runtime avoids unsafe retries for non idempotent operations.

REL 08  Hedged requests  A later opt in policy may start a second provider after a delay. The first accepted result wins and both attempts are costed.

REL 09  Graceful shutdown  The gateway stops accepting new work waits for configured in flight calls flushes telemetry and reports anything abandoned.

Retry Classification

Routing

Routing remains explicit and configuration driven.

RTE 01  Alias resolution  Resolve an alias to a configured connection and exact model string.

RTE 02  Fallback chain  Try a declared sequence when an error class qualifies for fallback.

RTE 03  Weighted distribution  Distribute calls across explicitly configured routes for load sharing or experiments.

RTE 04  Round robin and random  Provide deterministic round robin and seeded random strategies.

RTE 05  Health aware selection  Skip an open circuit or connection known to be unavailable.

RTE 06  Custom router  A hook may select a configured route using application metadata. The selection reason must appear in traces.

RTE 07  No implicit quality claims  Built in routing does not label models as better faster or smarter.

9 Validation Logging and Observability

Canonical Request and Response

CAN 01  Logical request  Preserve what the developer supplied including alias operation messages tools schema metadata and provider options.

CAN 02  Canonical request  Normalize common request fields into a provider neutral versioned structure.

CAN 03  Wire request  Capture endpoint method headers metadata and exact body produced by the adapter. Secrets are redacted before any persistent sink receives the record.

CAN 04  Raw response  Retain provider request IDs headers usage and response payload according to logging policy.

CAN 05  Normalized response  Return stable content tool usage finish reason cost timing and provider metadata fields.

CAN 06  Transformation record  Inspection mode shows how logical fields map to canonical and wire fields without deep cloning every request during normal execution.

CAN 07  Versioned contracts  Canonical structures and serialized trace records carry schema versions for replay and adapter compatibility.

Schema and Structured Output

Runtime validation and provider structured output are separate concerns and must be represented separately.

VAL 01  Schema agnostic input  Accept Standard Schema compatible validators raw JSON Schema Standard JSON Schema or a custom parse and validate adapter.

VAL 02  Provider schema conversion  Convert available JSON Schema into each provider structured output or tool format inside the adapter.

VAL 03  Native first strategy  Use native structured output when supported then tool calling then explicit JSON prompting only when configured.

VAL 04  Runtime validation  Parse the model result and validate it after every successful provider response.

VAL 05  Typed result  TypeScript infers the output type when the supplied validator exposes one.

VAL 06  Strict mode  Return a normalized validation error with issues raw content and attempt history.

VAL 07  Repair mode  Optionally run a separately traced and costed repair call with bounded attempts and a configurable repair model.

VAL 08  Coercion policy  Coercion is explicit. The runtime does not silently convert strings to numbers or discard unknown fields unless requested.

VAL 09  Partial validation  A later stream mode may validate complete substructures as they become available without claiming the entire output is valid early.

Tool and Function Calling

TLS 01  Canonical tool definition  Normalize names descriptions parameter schemas and execution metadata.

TLS 02  Provider conversion  Adapters map canonical tools to provider functions or equivalent constructs.

TLS 03  Argument validation  Validate tool arguments before execution and expose clear validation issues.

TLS 04  Execution helper  An optional loop executes registered handlers returns results to the model and stops at configured step time and cost limits.

TLS 05  Manual control  Developers can receive tool calls and execute them themselves without using the helper loop.

TLS 06  Parallel calls  Support multiple tool calls while respecting tool level concurrency and cancellation.

TLS 07  Tool error policy  Developers choose whether a tool failure returns to the model retries the tool aborts or fails over.

TLS 08  Sensitive output policy  Tool results pass through redaction and size limits before logs or traces.

Logging

LOG 01  Logging modes  Support none metadata full and custom payload policies. Metadata is the safe default.

LOG 02  Exact outbound view  Inspection records show the final provider endpoint model parameters and sanitized body immediately before transport.

LOG 03  Redaction  Compile field path header pattern and callback redactors at startup. Redaction occurs before console file or remote export.

LOG 04  Structured events  Emit machine readable events with request trace span attempt provider model alias tenant latency tokens cost status and error class.

LOG 05  Pluggable sinks  Support console custom callback and common structured logging libraries without forcing one logger.

LOG 06  Payload limits  Large content is truncated hashed or omitted according to policy while preserving byte and token counts.

LOG 07  Sampling  Success logs may be sampled deterministically while errors and policy violations can be retained.

LOG 08  Developer inspector  A local inspect mode formats logical canonical wire raw and normalized records for debugging.

Tracing and Metrics

OBS 01  Trace hierarchy  One request span contains queue routing policy provider attempt validation repair cache tool and export observations.

OBS 02  Context propagation  Accept explicit trace context and support runtime context propagation where available.

OBS 03  Timing detail  Record queue wait connection time time to first token generation duration validation time and total latency where measurable.

OBS 04  Usage detail  Record input output cached reasoning audio image and other provider reported usage categories without flattening unknown fields.

OBS 05  Exporter interface  Provide OpenTelemetry aligned spans events and metrics with optional Langfuse and console exporters.

OBS 06  Buffered export  Batch telemetry in a bounded memory queue with flush interval backpressure and drop counters.

OBS 07  Core metrics  Expose request rate success rate latency queue depth wait time tokens cost retries fallbacks errors validation failures and circuit state.

OBS 08  Correlation  Return request and trace identifiers to application code and include provider request IDs when present.

OBS 09  Custom metadata  Attach tenant user feature release experiment and business identifiers subject to an allowlist and redaction policy.

10 Cost Security and Governance

Usage Cost and Budgets

CST 01  Normalized usage  Store provider reported token and request usage while marking estimates and missing categories clearly.

CST 02  Configurable prices  Applications provide or override model prices by effective date. The core does not require a package update for each price change.

CST 03  Cost calculation  Calculate input output cache reasoning media tool repair retry fallback and shadow request cost when prices are known.

CST 04  Attribution  Aggregate cost by tenant user feature alias model provider connection environment and custom tags.

CST 05  Hierarchical budgets  Support organization project tenant feature and user budgets with daily weekly monthly rolling or custom periods.

CST 06  Soft and hard limits  Soft limits emit events or callbacks. Hard limits reject before execution when projected spend would exceed policy.

CST 07  Reservation  Optionally reserve projected request cost then reconcile against actual cost to reduce budget races.

CST 08  Unknown price policy  Allow warn or block when a model has no configured price.

CST 09  Alerts  Callbacks emit threshold crossings unusual spend rate and budget reset events.

Security and Privacy

SEC 01  Secret safety  Never serialize credentials into effective configuration logs traces errors replay records or generated files.

SEC 02  Safe payload defaults  Prompt response reasoning and tool content are not persisted unless the application opts in.

SEC 03  Redaction before export  Sensitive fields are removed in process before an event reaches any logging or telemetry backend.

SEC 04  Provider allowlists  Policies may restrict providers connections models regions base URLs and operations by tenant or environment.

SEC 05  Data handling metadata  Connections may declare retention training residency and compliance properties. The runtime enforces only explicitly configured policies and does not infer provider guarantees.

SEC 06  Custom encryption hook  Applications can encrypt persisted replay or audit content before storage.

SEC 07  Retention controls  Optional stores accept TTL deletion and maximum size policies.

SEC 08  Tenant isolation  Tenant context scopes limits budgets cache keys and telemetry to prevent cross tenant leakage.

SEC 09  Safe error exposure  Normalized errors omit sensitive raw data by default. Privileged inspection may access sanitized diagnostic records.

SEC 10  Dependency discipline  Core avoids native extensions and minimizes runtime dependencies. Releases include provenance checks and a software bill of materials.

Caching

CAC 01  Optional backend  Cache is disabled by default and uses memory custom or Redis compatible adapters when enabled.

CAC 02  Deterministic cache key  Hash canonical input model connection relevant parameters schema tools and selected metadata after redaction rules are applied.

CAC 03  Exact cache  Reuse a response only for an equivalent deterministic key and compatible runtime schema version.

CAC 04  Provider prompt cache  Expose provider prompt caching features through normalized metadata and provider options.

CAC 05  Semantic cache  A later plugin may reuse similar requests with explicit threshold namespace and safety policy.

CAC 06  Streaming replay  Cached streaming responses may be returned as canonical events with configurable pacing and a cache marker.

CAC 07  Privacy scope  Tenant user and authorization context participate in keys when configured. Cross tenant reuse is disabled by default.

CAC 08  Stampede control  Coalesce identical in flight requests or use backend locks when enabled.

Policies and Governance

POL 01  Request allow and deny rules  Inspect operation model connection metadata token estimate and provider options before scheduling.

POL 02  Parameter bounds  Set maximum input output temperature tool steps timeout and payload size at gateway alias tenant or feature scope.

POL 03  Policy result  Every rejection includes a stable rule ID reason scope and remediation metadata without leaking secrets.

POL 04  Audit events  Budget limit policy change redaction failure and restricted route events are emitted to configured sinks.

POL 05  Custom policy hook  Applications can add synchronous local checks. Network based checks require explicit timeout and failure behavior.

11 Performance Portability and Operations

Performance

PERF 01  Negligible hot path overhead  Target below 5 ms p95 for core processing excluding provider network time schema repair cache backend and synchronous user hooks.

PERF 02  No repeated compilation  Compile schemas redaction paths routing tables and configuration during initialization where possible.

PERF 03  Bounded allocations  Avoid deep cloning full prompts and responses. Capture full payload copies only when policy requires them.

PERF 04  Connection reuse  Reuse provider clients HTTP agents and keep alive connections where the runtime permits.

PERF 05  Lazy optional code  Do not load exporters tokenizers caches or provider adapters that the application did not import.

PERF 06  Benchmark suite  Publish cold start hot path scheduling stream and telemetry overhead results with the tested runtime and hardware.

Runtime Compatibility

RUN 01  Standards based core  Use fetch Web Streams AbortController URL crypto and other portable web APIs.

RUN 02  Node support  Support active Node LTS versions with ESM first packaging and clear CommonJS interop where feasible.

RUN 03  Alternative runtimes  Test Bun Deno Cloudflare Workers Vercel Edge and AWS Lambda through a published compatibility matrix.

RUN 04  No filesystem dependency in core  File logging replay stores and local configuration loaders live in optional Node specific modules.

RUN 05  Serverless behavior  Expose flush and waitUntil integration so telemetry and usage reconciliation are not lost at request termination.

RUN 06  Browser boundary  A later browser safe subset must require user supplied short lived credentials and must not encourage embedding provider secrets in client bundles.

Operational Lifecycle

OPS 01  Readiness report  Expose initialized adapters config validity scheduler state and exporter health without sending model traffic.

OPS 02  Diagnostic snapshot  Return sanitized queue limits circuit state recent aggregate errors and exporter drops.

OPS 03  Graceful flush  Provide flush and close methods with deadlines for telemetry stores and distributed coordinators.

OPS 04  Event hooks  Emit lifecycle events for configuration request queue attempt response validation and shutdown.

OPS 05  Clock injection  Schedulers budgets and retries accept an injected clock for deterministic tests.

OPS 06  Random source injection  Jitter weighted routing and sampling accept an injected seeded random source.

Testing and Simulation

TST 01  Mock provider  A first party mock adapter returns text streams tools usage delays and controlled failures without network access.

TST 02  Record and replay fixture  Tests can save sanitized provider responses and replay them under a versioned fixture format.

TST 03  Fault injection  Simulate 429 5xx timeout disconnect malformed stream schema failure missing usage and slow consumer behavior.

TST 04  Adapter contract suite  Every provider adapter must pass shared generation stream tool usage error cancellation and redaction tests.

TST 05  Scheduler determinism  Virtual time verifies RPM TPM concurrency fairness refund cancellation and distributed race behavior.

TST 06  Type tests  Compile time tests verify alias inference schema result types provider option names and error narrowing.

TST 07  Compatibility tests  CI runs against supported runtimes and representative OpenAI compatible servers.

Extension System

EXT 01  Provider adapter contract  Adapters transform requests execute and stream transform responses classify errors report usage and expose stable capabilities.

EXT 02  Lifecycle plugin  Plugins receive typed immutable context at documented points before and after policy scheduling cache provider validation and response.

EXT 03  Isolation  Plugin failures follow configured fail open or fail closed behavior and appear in traces.

EXT 04  Compatibility declaration  Plugins declare supported core and canonical schema versions.

EXT 05  No hidden mutation  Hooks return explicit patches or decisions instead of mutating shared request state.

EXT 06  Community packages  Provider cache telemetry validator and policy integrations can ship independently from core releases.

CLI Commands

CLI 01  init  Inspect the project and generate a minimal configuration after user confirmation.

CLI 02  doctor  Validate runtime optional peer dependencies credentials presence connectivity only when requested and adapter compatibility.

CLI 03  config  Print the effective sanitized configuration and precedence source.

CLI 04  providers  List configured connections adapter versions and declared capabilities.

CLI 05  models  List user configured aliases and direct mappings. It does not fetch or recommend a global model catalogue.

CLI 06  test  Send an explicit low cost test call after showing provider model and estimated limits.

CLI 07  inspect  Render a saved sanitized request lifecycle with logical canonical wire raw and normalized stages.

CLI 08  replay  Replay a stored record using the same or an explicitly selected alias and compare outputs usage cost and latency.

CLI 09  benchmark  Measure package overhead scheduler throughput and exporter impact without presenting provider latency as library performance.

Experiments and Evaluation Support

EXP 01  Deterministic assignment  Assign traffic to explicitly configured routes using a stable key and percentage.

EXP 02  Shadow requests  Send a sampled duplicate to another configured route without changing the user response. Shadow cost and errors remain visible.

EXP 03  Replay  Recreate a sanitized request using stored canonical data and compare models providers or configuration versions.

EXP 04  Comparison record  Store response validity latency usage cost stop reason and application supplied evaluation results.

EXP 05  Evaluator hook  Applications may attach synchronous or asynchronous evaluators. The runtime does not prescribe evaluation metrics.

EXP 06  Production safety  Experiments require sampling limits budget limits redaction and a separate concurrency allocation.

12 Example Product Interface

The exact names may change during implementation. The example demonstrates the intended level of abstraction and the locked alias behavior.

import { createGateway } from "llm-runtime";
import { gemini } from "llm-runtime/providers/gemini";
import { openai } from "llm-runtime/providers/openai";
import { langfuse } from "llm-runtime/telemetry/langfuse";

export const llm = createGateway({
  providers: {
    google: gemini({ apiKey: process.env.GEMINI_API_KEY! }),
    openai: openai({ apiKey: process.env.OPENAI_API_KEY! }),
  },

  models: {
    main_model: {
      provider: "google",
      model: "gemini-3.0-flash-preview",
      fallback: ["backup_model"],
    },
    eval_model: {
      provider: "google",
      model: "gemini-3.1-pro",
    },
    backup_model: {
      provider: "openai",
      model: process.env.BACKUP_MODEL!,
    },
  },

  limits: {
    concurrency: 50,
    rpm: 1000,
    tpm: 2_000_000,
    queueSize: 5000,
  },

  reliability: {
    timeoutMs: 30_000,
    maxAttempts: 3,
    backoff: "exponential-jitter",
  },

  logging: {
    payloads: "metadata",
    redact: ["authorization", "*.apiKey", "*.password"],
  },

  telemetry: {
    exporters: [langfuse({ flushIntervalMs: 1000 })],
  },
});

Application Calls

const response = await llm.generate({
  model: "main_model",
  messages,
});

const direct = await llm.generate({
  provider: "google",
  model: "gemini-3.1-pro",
  messages,
  providerOptions: {
    gemini: { thinkingConfig: { thinkingBudget: 2048 } },
  },
});

const result = await llm.generate({
  model: "main_model",
  messages,
  output: CustomerSchema,
  validation: { mode: "repair", maxAttempts: 1 },
});

Normalized Result Shape

{
  id: string,
  traceId: string,
  provider: string,
  model: string,
  alias?: string,
  content: Array<ContentPart>,
  text: string,
  toolCalls: ToolCall[],
  finishReason: FinishReason,
  usage: NormalizedUsage,
  cost?: Money,
  timing: RequestTiming,
  attempts: AttemptSummary[],
  providerMetadata: Record<string, unknown>,
  raw?: unknown
}

Normalized Error Taxonomy

13 Release Plan

Version 0 1 Core Runtime

TypeScript ESM package with createGateway and one canonical request and response model.

OpenAI Anthropic Gemini and OpenAI compatible adapters.

User defined model aliases and direct provider plus model calls.

generate stream tools structured output and embeddings.

Memory scheduler with concurrency RPM TPM token reservation queue timeout and cancellation.

Timeout typed retries exponential jitter explicit fallback and normalized errors.

Schema agnostic validation through Standard Schema raw JSON Schema or custom adapters.

Metadata logging exact sanitized wire inspection OpenTelemetry aligned tracing and optional Langfuse exporter.

Provider reported usage configurable prices request cost and basic attribution.

CLI init doctor config providers models test and inspect.

Mock provider adapter contract suite benchmarks and generated API documentation.

Version 0 2 Production Controls

Distributed scheduler adapter priority classes tenant fairness and bounded shared quotas.

Circuit breaker cache contracts exact cache stampede control and provider prompt cache support.

Schema repair tool execution helper and hierarchical budget enforcement.

Batch flex and offline execution adapters where providers support them.

Replay shadow requests deterministic experiments and evaluator hooks.

Metrics exporter structured logger adapters and configuration migration tools.

Version 1 0 Stable Runtime

Stable canonical schema public adapter contract and plugin compatibility policy.

Published runtime compatibility guarantees for Node and selected edge platforms.

Adaptive provider rate feedback controlled configuration reload and hardened multitenant policies.

Additional provider adapters based on community demand and maintenance capacity.

Security release process provenance software bill of materials and long term support policy.

Performance and reliability service level objectives backed by public benchmarks and failure tests.

Later Capability Tracks

Image audio video and provider file APIs through separate operation packages.

Semantic cache plugin and advanced storage integrations.

Optional HTTP gateway mode for polyglot services without changing the library first architecture.

Cost forecasting anomaly alerts cross region failover and enterprise policy distribution.

Community adapter registry with compatibility verification and signed package metadata.

14 Acceptance Criteria

Quality Requirements

All public behavior has stable typed errors and documented cancellation semantics.

No hidden network call occurs during import or gateway initialization.

No optional integration is bundled into the core unless every caller needs it.

Unknown provider usage price or capability data is labeled unknown or estimated instead of being invented.

Retries repairs fallbacks shadow requests cache hits and dropped telemetry are observable.

All queues buffers retries tool loops and stored payloads have explicit upper bounds.

15 Excluded Scope

The package owns model API execution. The following concerns should remain separate products or application code unless a narrow API execution primitive is needed.

Automatic selection of a fast smart reasoning or best model.

A package maintained model leaderboard price catalogue or model recommendation engine.

Agent planning autonomous task execution long term agent memory or workflow graphs.

RAG pipelines document loaders chunking vector databases rerankers or retrieval orchestration.

Prompt authoring user interface hosted dashboard or full evaluation platform in the first release.

Web scraping browser automation MCP orchestration or application specific tools.

A mandatory proxy server control plane database Redis cluster or telemetry vendor.

A mandatory validation library provider SDK or logging framework.

Silent prompt rewriting safety rewriting model substitution or schema coercion.

Storage of full prompts responses or reasoning content by default.

Boundary Examples

16 Open Product Decisions

These choices should be resolved before implementation hardens the public API. They do not change the product boundary described above.

Recommended First Implementation Slice

1.  Define canonical generation response stream event usage and normalized error types.

2.  Implement the provider adapter contract and one OpenAI compatible adapter.

3.  Build alias resolution direct model calls timeout cancellation and exact sanitized wire inspection.

4.  Add memory concurrency and RPM control then add TPM reservation and reconciliation.

5.  Add OpenAI Gemini and Anthropic adapters against the same contract suite.

6.  Add schema agnostic validation tools tracing usage and cost without changing the canonical boundary.

7.  Ship the CLI initializer only after the manual integration API is stable and minimal.

End of product requirements


| Area | Target outcome | How it is measured |
| --- | --- | --- |
| Integration | First valid call within 10 minutes | Fresh sample project and documented setup test |
| Runtime overhead | Below 5 ms p95 excluding network and optional schema repair | Benchmark with telemetry disabled and enabled |
| Reliability | No retries for known permanent errors | Fault injection and adapter contract tests |
| Quota control | Configured local RPM TPM and concurrency are not exceeded | Deterministic scheduler tests |
| Debuggability | Every failed call has a request ID route decision attempt history and sanitized wire payload metadata | Error contract and inspection tests |
| Portability | Core works in supported Node Bun Deno and edge compatible runtimes | Runtime compatibility matrix in CI |

| User | Primary need | Expected product behavior |
| --- | --- | --- |
| Application developer | Use several providers through one typed API | Simple setup aliases direct IDs normalized results and escape hatches |
| Platform engineer | Enforce shared limits and reliability behavior | Central config scheduling budgets fallbacks policies and distributed adapters |
| AI engineer | Inspect prompts outputs tools and validation | Exact payload view structured outputs repair traces replay and mocks |
| SRE | Explain latency errors and quota pressure | Queue timing attempt history metrics health state and error taxonomy |
| Security engineer | Prevent sensitive content from leaking | Default safe logs redaction controls encryption hooks and retention policies |
| FinOps owner | Attribute and cap model spend | Token and cost records budgets tags alerts and configurable pricing |

| Module | Responsibility | Core or optional |
| --- | --- | --- |
| core | Canonical types pipeline hooks and public API | Core |
| providers | Provider request response stream and error adapters | Separate packages or subpaths |
| registry | Configured connections aliases and declared capabilities | Core |
| scheduler | Concurrency RPM TPM queues reservations and reconciliation | Core memory adapter |
| reliability | Timeout retries backoff fallback and circuit state | Core |
| validation | Schema conversion parsing validation and repair policy | Core interfaces optional adapters |
| telemetry | Traces logs metrics context and exporters | Core interfaces optional exporters |
| cost | Usage normalization prices attribution and budgets | Core with user supplied data |
| cache | Cache key policy and backend contract | Optional |
| cli | Initialize inspect validate test and diagnose configuration | Separate package |

| Domain | Must | Should | Later |
| --- | --- | --- | --- |
| Configuration | Single gateway file aliases validation environment references | CLI migration and dependency scan | Remote configuration and controlled hot reload |
| Providers | OpenAI Anthropic Gemini OpenAI compatible | Azure OpenAI Bedrock Vertex and OpenRouter | Community adapter registry |
| Operations | Generate stream tools structured output embeddings | Batch and flex execution | Image audio video and provider files |
| Control | Concurrency RPM TPM timeout cancellation | Distributed scheduler priorities and fairness | Adaptive rate learning |
| Reliability | Typed retries backoff fallback normalized errors | Circuit breaker hedging and idempotency | Cross region failover |
| Observability | Exact sanitized logs traces usage cost | Metrics dashboards adapters and replay | Live diagnostics service |
| Validation | Schema agnostic parsing validation strict mode | Repair coercion and partial stream validation | Custom validation pipelines |
| Economics | Token and request cost tracking | Budgets attribution alerts and price overrides | Forecasting and anomaly detection |
| Experiments | Trace metadata and deterministic sampling hooks | Shadow requests replay and A B assignment | Automated evaluation workflows |
| Portability | Node ESM fetch streams AbortSignal | Bun Deno and major edge runtimes | Browser safe subset |

| Operation | Required behavior | Phase |
| --- | --- | --- |
| generate | Text or multimodal request normalized response usage metadata and structured output | Must |
| stream | Async iterable canonical events final response usage abort and backpressure | Must |
| tools | Provider neutral tool definitions streamed arguments execution loop helper and limits | Must |
| embed | Single and array inputs dimensions usage normalization and batching helper | Must |
| batch | Local queue first then native provider batch flex or offline modes when supported | Should |
| image | Generation and edit request normalization with provider options | Later |
| audio | Speech transcription and translation adapters with streaming where available | Later |
| files | Upload reference lifecycle and cleanup abstractions where providers require files | Later |

| Failure | Default action | Reason |
| --- | --- | --- |
| Rate limit | Delay then retry or configured fallback | Usually temporary and may include a provider wait duration |
| Provider 5xx or overload | Retry then fallback | Transient infrastructure failure |
| Connection timeout before output | Retry when operation is safe | No response was exposed |
| Authentication failure | Fail immediately | Retry cannot repair credentials |
| Context too large | Fail or configured transformer | Same request will fail again unchanged |
| Validation failure | Strict failure or visible repair attempt | Requires different output rather than transport retry |
| Unsupported feature | Fail or explicit capable fallback | Provider cannot execute the request |
| Budget exceeded | Fail immediately | Policy intentionally blocks further spend |
| Content policy rejection | Fail unless an explicit policy route exists | Automatic retry can repeat the same violation |

| Error class | Typical causes | Important fields |
| --- | --- | --- |
| LLMConfigurationError | Invalid gateway connection alias or policy | path code remediation |
| LLMAuthenticationError | Missing expired or rejected credentials | provider providerCode retryable false |
| LLMRateLimitError | RPM TPM or provider quota exhausted | scope retryAfter limit remaining |
| LLMTimeoutError | Queue connect first token idle or total deadline | phase elapsed retryable |
| LLMContextLengthError | Input or requested output exceeds context | estimatedTokens maximumTokens |
| LLMValidationError | Parse schema or structured output mismatch | issues rawContent repairAttempts |
| LLMBudgetExceededError | Projected or actual spend exceeds policy | scope budget spent resetAt |
| LLMUnsupportedFeatureError | Adapter or declared model lacks a feature | feature provider model |
| LLMContentPolicyError | Provider or local policy rejected content | providerCode policy retryable |
| LLMProviderError | Provider specific non normalized failure | status providerCode raw sanitized |
| LLMOverloadedError | Local queue or provider capacity unavailable | queueSize concurrency retryAfter |
| LLMCancelledError | Caller or shutdown cancelled execution | phase partialOutput |

| Area | Release gate |
| --- | --- |
| Configuration | A fresh TypeScript project can initialize validate and complete a real provider call from one gateway file. |
| Aliases | Changing an alias model string requires no package change and direct provider model calls continue to work. |
| Provider parity | Shared contract tests pass for generation streaming tools usage cancellation timeouts and normalized errors. |
| Wire inspection | Inspection mode shows the sanitized final request body and provider response metadata for every attempt. |
| Scheduling | Virtual time tests prove configured local concurrency RPM and TPM limits including reservation refunds and cancellations. |
| Reliability | Permanent errors do not retry and fallback occurs only for configured eligible failures. |
| Validation | At least two Standard Schema compatible libraries plus raw JSON Schema work without a core dependency on either library. |
| Observability | A trace explains queue wait route attempts provider latency validation retries usage and cost without blocking the response on export. |
| Security | Credential and redaction tests prove secrets do not appear in configuration inspection logs traces errors or replay fixtures. |
| Performance | Published benchmark shows less than 5 ms p95 core overhead under the declared test setup. |
| Portability | Supported runtimes pass build import generation stream and cancellation test suites. |
| Documentation | Reference docs cover public types config precedence failure behavior privacy defaults extension interfaces and migration examples. |

| Capability | Inside the product | Outside the product |
| --- | --- | --- |
| Embeddings | Execute and control an embeddings API call | Chunk documents and build an indexing pipeline |
| Tools | Normalize tool definitions calls and bounded execution | Plan an autonomous agent workflow |
| Caching | Cache a model API response through an adapter | Operate a general application cache platform |
| Evaluation | Attach metadata replay shadow and evaluator hooks | Provide a complete labeling and experiment dashboard |
| Policies | Enforce explicit request route budget and logging rules | Decide company AI governance policy |
| Models | Resolve user aliases and execute explicit routes | Recommend or automatically rank models |

| Decision | Recommended starting position | Reason to revisit |
| --- | --- | --- |
| Package layout | Core plus documented subpath exports | Separate packages may improve independent versioning but increase release overhead |
| Provider transport | Use fetch directly with optional custom transport | Some provider SDKs may expose unique features or signing logic |
| CommonJS | ESM first with tested interop guidance | Market demand may justify dual builds despite complexity |
| Schema standard | Standard Schema plus raw JSON Schema and custom interface | Conversion coverage differs across validation libraries |
| Tokenizer strategy | Optional provider tokenizers with conservative fallback | Bundled tokenizers increase size and runtime constraints |
| Price data | Application supplied values with optional separate data package | Users may want convenience updates without coupling core releases |
| Replay storage | Interface plus local development adapter | Production storage requirements vary by privacy and scale |
| Config reload | Immutable after initialization for first release | Long lived services may need atomic remote updates |
| HTTP gateway | Keep outside first release | Polyglot teams may later need a shared process or service |
| Naming | Choose after API prototype and registry search | The package name should describe the runtime without implying model intelligence |
