/** Versioned, provider-neutral API. Provider model strings are never enumerated. */
export const SCHEMA_VERSION = "1" as const;
export type JsonSchema = boolean | { [key: string]: unknown };
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; data?: string; mimeType?: string }
  | { type: "reasoning"; text: string };
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}
export interface Tool {
  name: string;
  description?: string;
  parameters: JsonSchema;
}
export interface StandardSchema<T = unknown> {
  "~standard": {
    version: 1;
    vendor: string;
    types?: { input: unknown; output: T };
    validate(
      value: unknown,
    ):
      | { value: T; issues?: undefined }
      | { issues: ReadonlyArray<unknown> }
      | Promise<
          { value: T; issues?: undefined } | { issues: ReadonlyArray<unknown> }
        >;
  };
}
export interface Validator<T = unknown> {
  jsonSchema?: JsonSchema;
  parse(value: unknown): T | Promise<T>;
}
export type OutputSchema<T = unknown> =
  StandardSchema<T> | Validator<T> | JsonSchema;
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  metadata?: Record<string, string>;
  traceId?: string;
}
export interface GenerateRequest<T = unknown> extends RequestOptions {
  provider?: string;
  model: string;
  messages: Message[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
  tools?: Tool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  output?: OutputSchema<T>;
  jsonSchema?: JsonSchema;
  providerOptions?: Record<string, Record<string, unknown>>;
  estimatedInputTokens?: number;
}
export interface EmbedRequest extends RequestOptions {
  provider?: string;
  model: string;
  input: string | string[];
  dimensions?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  source: "provider" | "unknown" | "estimated";
  details?: Record<string, unknown>;
}
export type FinishReason =
  "stop" | "length" | "tool_calls" | "content_filter" | "unknown";
export interface ProviderResult {
  id?: string;
  content: ContentPart[];
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  providerMetadata: Record<string, unknown>;
}
export interface AttemptSummary {
  number: number;
  provider: string;
  model: string;
  status: "success" | "error";
  errorCode?: string;
  queueMs: number;
  durationMs: number;
  usage?: Usage;
  cost?: Money;
}
export interface Money {
  amount: number;
  currency: string;
}
export interface RequestTiming {
  totalMs: number;
  queueMs: number;
  providerMs: number;
  validationMs: number;
  firstTokenMs?: number;
}
export interface GenerateResult<T = unknown> extends ProviderResult {
  id: string;
  traceId: string;
  provider: string;
  model: string;
  alias?: string;
  data?: T;
  cost?: Money;
  timing: RequestTiming;
  attempts: AttemptSummary[];
}
export interface EmbedResult {
  id: string;
  traceId: string;
  provider: string;
  model: string;
  embeddings: number[][];
  usage: Usage;
  cost?: Money;
  attempts: AttemptSummary[];
  timing: RequestTiming;
}
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_delta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; finishReason: FinishReason }
  | { type: "metadata"; metadata: Record<string, unknown> };
export type StreamEvent<T = unknown> =
  ProviderEvent | { type: "result"; result: GenerateResult<T> };
export interface StreamResult<T = unknown> extends AsyncIterable<
  StreamEvent<T>
> {
  textStream(): AsyncIterable<string>;
  final(): Promise<GenerateResult<T>>;
  cancel(): void;
}
export interface WireRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
}
export interface CanonicalRequest {
  schemaVersion: "1";
  operation: "generate" | "stream" | "embed";
  model: string;
  request: GenerateRequest | EmbedRequest;
  jsonSchema?: JsonSchema;
}
export interface ProviderAdapter {
  name: string;
  version: string;
  capabilities: Readonly<{
    generate: boolean;
    stream: boolean;
    tools: boolean;
    structuredOutput: boolean;
    embeddings: boolean;
    vision: boolean;
  }>;
  prepare(request: CanonicalRequest): WireRequest | Promise<WireRequest>;
  fetch?: typeof globalThis.fetch;
  parse(body: unknown): ProviderResult;
  parseEmbedding?(body: unknown): { embeddings: number[][]; usage: Usage };
  parseStream?(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
export interface ProviderOptions {
  apiKey: string | (() => string | Promise<string>);
  baseURL?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}
export interface Limits {
  concurrency?: number;
  rpm?: number;
  tpm?: number;
  queueSize?: number;
  queueTimeoutMs?: number;
  windowMs?: number;
}
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface ModelAlias {
  provider: string;
  model: string;
  fallback?: string[];
  defaults?: Partial<
    Pick<GenerateRequest, "temperature" | "topP" | "maxOutputTokens" | "stop">
  >;
}
export interface RuntimeEvent {
  schemaVersion: "1";
  type: string;
  timestamp: number;
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
}
export interface Exporter {
  export(
    events: readonly RuntimeEvent[],
    signal?: AbortSignal,
  ): void | Promise<void>;
  close?(): void | Promise<void>;
}
export interface GatewayConfig {
  providers: Record<string, ProviderAdapter>;
  models?: Record<string, ModelAlias>;
  defaults?: ModelAlias["defaults"];
  limits?: Limits;
  scopedLimits?: {
    providers?: Record<string, Limits>;
    aliases?: Record<string, Limits>;
    tenants?: Record<string, Limits>;
    operations?: Partial<Record<"generate" | "stream" | "embed", Limits>>;
  };
  clock?: Clock;
  random?: () => number;
  reliability?: {
    timeoutMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    fallbackOn?: string[];
  };
  logging?: {
    payloads?: "none" | "metadata" | "full";
    redact?: string[];
    maxPayloadBytes?: number;
    sink?: (event: RuntimeEvent) => void;
  };
  telemetry?: {
    exporters?: Exporter[];
    maxQueueSize?: number;
    batchSize?: number;
    flushIntervalMs?: number;
    exportTimeoutMs?: number;
  };
  prices?: Record<
    string,
    {
      inputPerMillion: number;
      outputPerMillion: number;
      cachedInputPerMillion?: number;
      currency?: string;
    }
  >;
  maxResponseBytes?: number;
}
