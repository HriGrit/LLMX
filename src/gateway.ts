import type {
  GatewayConfig,
  GenerateRequest,
  GenerateResult,
  EmbedRequest,
  EmbedResult,
  ProviderAdapter,
  ProviderResult,
  StreamEvent,
  StreamResult,
  CanonicalRequest,
  Usage,
  Money,
  AttemptSummary,
  ModelAlias,
} from "./types.js";
import {
  LLMConfigurationError,
  LLMError,
  LLMUnsupportedFeatureError,
  cancelled,
  timeout,
  httpError,
  normalizeError,
} from "./errors.js";
import { MemoryScheduler, systemClock } from "./scheduler.js";
import { schemaFor, validateOutput } from "./validation.js";
import { Telemetry } from "./telemetry.js";
function bounded<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(normalizeError(undefined, signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(normalizeError(undefined, signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function number(value: unknown, name: string, integer = false): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  )
    throw new LLMConfigurationError(`Invalid ${name}`);
}
function cost(
  usage: Usage,
  price:
    | {
        inputPerMillion: number;
        outputPerMillion: number;
        cachedInputPerMillion?: number;
        currency?: string;
      }
    | undefined,
  embed = false,
): Money | undefined {
  if (
    !price ||
    usage.source !== "provider" ||
    usage.inputTokens === undefined ||
    (!embed && usage.outputTokens === undefined)
  )
    return;
  const cached = usage.cachedInputTokens ?? 0;
  return {
    amount:
      ((usage.inputTokens - cached) * price.inputPerMillion +
        cached * (price.cachedInputPerMillion ?? price.inputPerMillion) +
        (usage.outputTokens ?? 0) * price.outputPerMillion) /
      1e6,
    currency: price.currency ?? "USD",
  };
}
export function createGateway(input: GatewayConfig) {
  if (!input || !input.providers || !Object.keys(input.providers).length)
    throw new LLMConfigurationError("At least one provider is required");
  const config: GatewayConfig = {
    ...input,
    providers: { ...input.providers },
    models: structuredClone(input.models ?? {}),
    defaults: structuredClone(input.defaults ?? {}),
    limits: { ...input.limits },
    scopedLimits: structuredClone(input.scopedLimits ?? {}),
    reliability: { ...input.reliability },
    logging: { ...input.logging, redact: [...(input.logging?.redact ?? [])] },
    telemetry: {
      ...input.telemetry,
      exporters: [...(input.telemetry?.exporters ?? [])],
    },
    prices: structuredClone(input.prices ?? {}),
  };
  for (const [name, p] of Object.entries(config.providers)) {
    if (!p || p.version !== "1" || !p.prepare || !p.parse || !p.capabilities)
      throw new LLMConfigurationError(`Invalid provider adapter: ${name}`);
    config.providers[name] = Object.freeze({
      ...p,
      capabilities: Object.freeze({ ...p.capabilities }),
    });
  }
  const aliases = config.models!;
  for (const [name, alias] of Object.entries(aliases)) {
    if (!Object.hasOwn(config.providers, alias.provider) || !alias.model)
      throw new LLMConfigurationError(`Invalid alias: ${name}`);
    for (const fallback of alias.fallback ?? [])
      if (!Object.hasOwn(aliases, fallback))
        throw new LLMConfigurationError(`Unknown fallback alias: ${fallback}`);
    const visited = new Set<string>();
    function visit(key: string) {
      if (visited.has(key))
        throw new LLMConfigurationError("Fallback cycle detected");
      visited.add(key);
      for (const next of aliases[key].fallback ?? []) visit(next);
      visited.delete(key);
    }
    visit(name);
  }
  for (const defaults of [
    config.defaults,
    ...Object.values(aliases).map((a) => a.defaults),
  ]) {
    if (defaults?.maxOutputTokens !== undefined)
      number(defaults.maxOutputTokens, "default maxOutputTokens", true);
    if (
      defaults?.temperature !== undefined &&
      (!Number.isFinite(defaults.temperature) || defaults.temperature < 0)
    )
      throw new LLMConfigurationError("Invalid default temperature");
    if (
      defaults?.topP !== undefined &&
      (!Number.isFinite(defaults.topP) ||
        defaults.topP < 0 ||
        defaults.topP > 1)
    )
      throw new LLMConfigurationError("Invalid default topP");
  }
  const deadline = config.reliability?.timeoutMs ?? 30000,
    maxAttempts = config.reliability?.maxAttempts ?? 3,
    maxBytes = config.maxResponseBytes ?? 4 * 1024 * 1024;
  number(deadline, "timeoutMs");
  number(maxAttempts, "maxAttempts", true);
  number(maxBytes, "maxResponseBytes", true);
  for (const key of ["baseDelayMs", "maxDelayMs"] as const)
    if (config.reliability?.[key] !== undefined)
      number(config.reliability[key], key);
  for (const p of Object.values(config.prices!))
    for (const [k, v] of Object.entries(p))
      if (
        k !== "currency" &&
        (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      )
        throw new LLMConfigurationError(
          "Prices must be nonnegative finite numbers",
        );
  const pools: Record<string, import("./types.js").Limits> = {};
  for (const [scope, entries] of Object.entries(config.scopedLimits ?? {}))
    for (const [key, limits] of Object.entries(entries ?? {})) {
      if (
        (scope === "providers" && !Object.hasOwn(config.providers, key)) ||
        (scope === "aliases" && !Object.hasOwn(aliases, key))
      )
        throw new LLMConfigurationError("Unknown scoped quota target");
      pools[`${scope}:${key}`] = limits;
    }
  const clock = config.clock ?? systemClock,
    scheduler = new MemoryScheduler(config.limits, clock, pools),
    telemetry = new Telemetry(config);
  const inflight = new Set<AbortController>();
  let closed = false;
  const stats = {
    requests: 0,
    successes: 0,
    errors: 0,
    retries: 0,
    fallbacks: 0,
  };
  function resolve(
    provider: string | undefined,
    model: string,
  ): ModelAlias & { alias?: string } {
    if (provider) {
      if (!Object.hasOwn(config.providers, provider) || !model)
        throw new LLMConfigurationError("Unknown provider or empty model");
      return { provider, model };
    }
    if (!Object.hasOwn(aliases, model))
      throw new LLMConfigurationError(
        "Unknown alias; provide both provider and model for a direct call",
      );
    return { ...aliases[model], alias: model };
  }
  async function readJSON(
    response: Response,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!response.body)
      throw new LLMError("PROVIDER", "Empty provider response");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await bounded(reader.read(), signal);
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes)
          throw new LLMError(
            "PROVIDER",
            "Response exceeded configured byte limit",
          );
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const all = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      throw new LLMError("PROVIDER", "Invalid JSON response");
    }
  }
  async function* execute<T>(
    operation: "generate" | "stream" | "embed",
    request: GenerateRequest<T> | EmbedRequest,
  ): AsyncGenerator<
    StreamEvent<T> | { type: "embedding_result"; result: EmbedResult }
  > {
    if (closed) throw cancelled();
    let route = resolve(request.provider, request.model);
    if (
      operation !== "embed" &&
      (!Array.isArray((request as GenerateRequest).messages) ||
        !(request as GenerateRequest).messages.length)
    )
      throw new LLMConfigurationError("messages must be a nonempty array");
    if (operation === "embed") {
      const i = (request as EmbedRequest).input;
      if (!(
        (typeof i === "string" && i.length) ||
        (Array.isArray(i) &&
          i.length &&
          i.every((x) => typeof x === "string" && x.length))
      ))
        throw new LLMConfigurationError("input must contain nonempty strings");
    }
    const timeoutMs = request.timeoutMs ?? deadline;
    number(timeoutMs, "request timeoutMs");
    const controller = new AbortController(),
      signal = controller.signal;
    const onAbort = () => controller.abort(cancelled());
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    const timer = clock.setTimeout(
      () => controller.abort(timeout("Request")),
      Math.min(timeoutMs, deadline),
    );
    inflight.add(controller);
    stats.requests++;
    const id = crypto.randomUUID(),
      traceId = request.traceId ?? crypto.randomUUID().replaceAll("-", ""),
      spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      started = clock.now();
    const attempts: AttemptSummary[] = [];
    let emitted = false,
      queueMs = 0,
      providerMs = 0,
      validationMs = 0,
      firstTokenMs: number | undefined;
    const emit = (
      type: string,
      attributes: Record<string, unknown>,
      attemptSpan?: string,
    ) =>
      telemetry.emit({
        schemaVersion: "1",
        type,
        timestamp: clock.now(),
        requestId: id,
        traceId,
        spanId: attemptSpan ?? spanId,
        parentSpanId: attemptSpan ? spanId : undefined,
        attributes,
      });
    const fallbackNames: string[] = [];
    function appendFallbacks(names: string[]) {
      for (const name of names) {
        if (!fallbackNames.includes(name)) {
          fallbackNames.push(name);
          appendFallbacks(aliases[name].fallback ?? []);
        }
      }
    }
    appendFallbacks(route.fallback ?? []);
    emit("request.start", {
      operation,
      provider: route.provider,
      model: route.model,
      alias: route.alias,
      metadata: request.metadata,
      logical: request,
    });
    try {
      for (let n = 1; n <= maxAttempts; n++) {
        if (signal.aborted) throw normalizeError(undefined, signal);
        const adapter: ProviderAdapter = config.providers[route.provider];
        const req =
          operation === "embed"
            ? request
            : ({
                maxOutputTokens: 1024,
                ...config.defaults,
                ...route.defaults,
                ...request,
              } as GenerateRequest<T>);
        const generation = req as GenerateRequest<T>;
        const canonical: CanonicalRequest = {
          schemaVersion: "1",
          operation,
          model: route.model,
          request: req as GenerateRequest | EmbedRequest,
          jsonSchema:
            operation === "embed"
              ? undefined
              : schemaFor(generation.output, generation.jsonSchema),
        };
        let release: ((actual?: number) => void) | undefined,
          attemptStart = clock.now(),
          providerStart = attemptStart,
          waited = 0,
          actual: Usage | undefined,
          attemptCost: Money | undefined;
        let response: Response | undefined;
        const attemptSpan = crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 16);
        try {
          if (
            !adapter.capabilities[
              operation === "embed" ? "embeddings" : operation
            ]
          )
            throw new LLMUnsupportedFeatureError(operation);
          if (generation.tools?.length && !adapter.capabilities.tools)
            throw new LLMUnsupportedFeatureError("tools");
          if (
            canonical.jsonSchema !== undefined &&
            !adapter.capabilities.structuredOutput
          )
            throw new LLMUnsupportedFeatureError("structured output");
          if (generation.tools)
            for (const tool of generation.tools) schemaFor(tool.parameters);
          if (generation.maxOutputTokens !== undefined)
            number(generation.maxOutputTokens, "maxOutputTokens", true);
          const estimate =
            operation === "embed"
              ? new TextEncoder().encode(
                  JSON.stringify((req as EmbedRequest).input),
                ).length
              : (generation.estimatedInputTokens ??
                new TextEncoder().encode(
                  JSON.stringify({
                    messages: generation.messages,
                    tools: generation.tools,
                    schema: canonical.jsonSchema,
                  }),
                ).length);
          const reserved =
            estimate +
            (operation === "embed" ? 0 : (generation.maxOutputTokens ?? 1024));
          const wire = await bounded(
            Promise.resolve(adapter.prepare(canonical)),
            signal,
          );
          // Serialize once, then use precisely these bytes for both transport and inspection.
          const serialized = JSON.stringify(wire.body);
          release = await scheduler.acquire(reserved, signal, [
            `providers:${route.provider}`,
            `aliases:${route.alias}`,
            `tenants:${request.metadata?.tenantId}`,
            `operations:${operation}`,
          ]);
          waited = clock.now() - attemptStart;
          queueMs += waited;
          signal.addEventListener("abort", releaseOnAbort, { once: true });
          emit(
            "queue.end",
            { attempt: n, queueMs: waited, reservedTokens: reserved },
            attemptSpan,
          );
          emit(
            "attempt.start",
            {
              attempt: n,
              provider: route.provider,
              model: route.model,
              canonical,
              wire:
                config.logging?.payloads === "full"
                  ? { ...wire, body: JSON.parse(serialized) }
                  : undefined,
            },
            attemptSpan,
          );
          providerStart = clock.now();
          const transport = adapter.fetch ?? globalThis.fetch;
          const pending = transport(wire.url, {
            method: wire.method,
            headers: wire.headers,
            body: serialized,
            signal,
          });
          void pending.then(
            (r) => {
              if (signal.aborted) void r.body?.cancel().catch(() => {});
            },
            () => {},
          );
          response = await bounded(pending, signal);
          if (!response.ok) {
            const err = httpError(response);
            void response.body?.cancel().catch(() => {});
            throw err;
          }
          emit(
            "response.headers",
            {
              attempt: n,
              status: response.status,
              providerRequestId:
                response.headers.get("x-request-id") ??
                response.headers.get("request-id"),
            },
            attemptSpan,
          );
          let parsed: ProviderResult | undefined,
            embeddings: number[][] | undefined;
          if (operation === "stream") {
            if (!adapter.parseStream || !response.body)
              throw new LLMUnsupportedFeatureError("stream parser");
            parsed = {
              text: "",
              content: [],
              toolCalls: [],
              finishReason: "unknown",
              usage: { source: "unknown" },
              providerMetadata: {},
            };
            const calls = new Map<
              number,
              { id: string; name: string; arguments: string }
            >();
            let bytes = 0,
              finished = false;
            for await (const event of adapter.parseStream(
              response.body,
              signal,
            )) {
              if (signal.aborted) throw normalizeError(undefined, signal);
              bytes += new TextEncoder().encode(JSON.stringify(event)).length;
              if (bytes > maxBytes)
                throw new LLMError(
                  "PROVIDER",
                  "Stream exceeded configured byte limit",
                );
              if (event.type === "text_delta") {
                parsed.text += event.text;
                firstTokenMs ??= clock.now() - started;
              }
              if (event.type === "tool_delta") {
                if (
                  !Number.isInteger(event.index) ||
                  event.index < 0 ||
                  event.index >= 128
                )
                  throw new LLMError(
                    "PROVIDER",
                    "Tool call index exceeded limit",
                  );
                const t = calls.get(event.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };
                if (event.id) t.id = event.id;
                if (event.name) t.name += event.name;
                if (event.arguments) t.arguments += event.arguments;
                calls.set(event.index, t);
              }
              if (event.type === "usage") {
                parsed.usage = { ...parsed.usage, ...event.usage };
                actual = parsed.usage;
              }
              if (event.type === "finish") {
                parsed.finishReason = event.finishReason;
                finished = true;
              }
              if (event.type === "metadata")
                parsed.providerMetadata = {
                  ...parsed.providerMetadata,
                  ...event.metadata,
                };
              emitted = true;
              yield event;
            }
            if (!finished)
              throw new LLMError(
                "PROVIDER",
                "Stream ended before a finish event",
              );
            parsed.content = parsed.text
              ? [{ type: "text", text: parsed.text }]
              : [];
            parsed.toolCalls = [...calls.values()];
          } else {
            const raw = await readJSON(response, signal);
            emit("response.raw", { attempt: n, raw }, attemptSpan);
            if (operation === "embed") {
              if (!adapter.parseEmbedding)
                throw new LLMUnsupportedFeatureError("embeddings");
              const result = adapter.parseEmbedding(raw);
              embeddings = result.embeddings;
              actual = result.usage;
            } else parsed = adapter.parse(raw);
          }
          providerMs += clock.now() - providerStart;
          actual = parsed?.usage ?? actual;
          const pricedUsage = actual ?? { source: "unknown" };
          attemptCost = cost(
            pricedUsage,
            config.prices?.[`${route.provider}/${route.model}`],
            operation === "embed",
          );
          release(actual?.totalTokens);
          release = undefined;
          signal.removeEventListener("abort", releaseOnAbort);
          let data: T | undefined;
          if (parsed && generation.tools?.length) {
            for (const call of parsed.toolCalls) {
              const tool = generation.tools.find((t) => t.name === call.name);
              if (!tool)
                throw new LLMError(
                  "VALIDATION",
                  "Provider returned an unregistered tool",
                );
              await bounded(
                validateOutput(call.arguments || "{}", tool.parameters),
                signal,
              );
            }
          }
          if (parsed && generation.output !== undefined) {
            const before = clock.now();
            data = await bounded(
              validateOutput(parsed.text, generation.output),
              signal,
            );
            validationMs += clock.now() - before;
            emit("validation.end", { valid: true, validationMs }, attemptSpan);
          }
          if (signal.aborted) throw normalizeError(undefined, signal);
          attempts.push({
            number: n,
            provider: route.provider,
            model: route.model,
            status: "success",
            queueMs: waited,
            durationMs: clock.now() - attemptStart,
            usage: actual,
            cost: attemptCost,
          });
          const shared = {
            id,
            traceId,
            provider: route.provider,
            model: route.model,
            alias: route.alias,
            cost: attemptCost,
            attempts,
            timing: {
              totalMs: clock.now() - started,
              queueMs,
              providerMs,
              validationMs,
              firstTokenMs,
            },
          };
          stats.successes++;
          emit(
            "attempt.end",
            { attempt: n, status: "success", usage: actual, cost: attemptCost },
            attemptSpan,
          );
          if (parsed) {
            const result: GenerateResult<T> = { ...parsed, ...shared, data };
            emit("request.end", {
              status: "success",
              timing: shared.timing,
              usage: actual,
              cost: attemptCost,
              normalized: result,
            });
            yield { type: "result", result };
          } else {
            const result: EmbedResult = {
              ...shared,
              embeddings: embeddings!,
              usage: pricedUsage,
            };
            emit("request.end", {
              status: "success",
              timing: shared.timing,
              usage: actual,
              cost: attemptCost,
            });
            yield { type: "embedding_result", result };
          }
          return;
        } catch (error) {
          const err = normalizeError(error, signal);
          err.partialOutput = emitted;
          attemptCost ??= actual
            ? cost(
                actual,
                config.prices?.[`${route.provider}/${route.model}`],
                operation === "embed",
              )
            : undefined;
          attempts.push({
            number: n,
            provider: route.provider,
            model: route.model,
            status: "error",
            errorCode: err.code,
            queueMs: waited,
            durationMs: clock.now() - attemptStart,
            usage: actual,
            cost: attemptCost,
          });
          emit(
            "attempt.end",
            {
              attempt: n,
              status: "error",
              code: err.code,
              partialOutput: emitted,
              usage: actual,
              cost: attemptCost,
            },
            attemptSpan,
          );
          release?.(actual?.totalTokens);
          release = undefined;
          void response?.body?.cancel().catch(() => {});
          const eligible = config.reliability?.fallbackOn ?? [
            "RATE_LIMIT",
            "PROVIDER",
            "UNSUPPORTED_FEATURE",
          ];
          const canFallback =
            fallbackNames.length > 0 &&
            eligible.includes(err.code) &&
            (err.retryable || err.code === "UNSUPPORTED_FEATURE");
          if (
            n >= maxAttempts ||
            emitted ||
            signal.aborted ||
            (!err.retryable && !canFallback)
          )
            throw err;
          if (canFallback) {
            route = resolve(undefined, fallbackNames.shift()!);
            stats.fallbacks++;
            emit("route.fallback", {
              attempt: n,
              provider: route.provider,
              model: route.model,
            });
          } else {
            stats.retries++;
            emit("retry", { attempt: n, code: err.code });
          }
          const maxDelay = config.reliability?.maxDelayMs ?? 10000;
          const delay =
            err.retryAfterMs !== undefined
              ? err.retryAfterMs
              : Math.min(
                  maxDelay,
                  (config.reliability?.baseDelayMs ?? 250) * 2 ** (n - 1),
                ) * (config.random ?? Math.random)();
          await new Promise<void>((res, rej) => {
            let t: unknown;
            const abort = () => {
              clock.clearTimeout(t);
              rej(normalizeError(undefined, signal));
            };
            signal.addEventListener("abort", abort, { once: true });
            t = clock.setTimeout(
              () => {
                signal.removeEventListener("abort", abort);
                res();
              },
              Math.max(0, delay),
            );
            if (signal.aborted) abort();
          });
        } finally {
          release?.(actual?.totalTokens);
          signal.removeEventListener("abort", releaseOnAbort);
        }
        function releaseOnAbort() {
          release?.();
          release = undefined;
        }
      }
    } catch (e) {
      const err = normalizeError(e, signal);
      err.requestId = id;
      err.traceId = traceId;
      err.attempts = attempts;
      err.partialOutput = emitted;
      stats.errors++;
      emit("request.end", {
        status: err.code === "CANCELLED" ? "cancelled" : "error",
        code: err.code,
        partialOutput: emitted,
        attempts,
      });
      throw err;
    } finally {
      clock.clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      inflight.delete(controller);
      controller.abort(cancelled());
    }
  }
  const gateway = {
    async generate<T = unknown>(
      request: GenerateRequest<T>,
    ): Promise<GenerateResult<T>> {
      for await (const e of execute("generate", request))
        if (e.type === "result") return e.result;
      throw new LLMError("PROVIDER", "Missing result");
    },
    async embed(request: EmbedRequest): Promise<EmbedResult> {
      for await (const e of execute("embed", request))
        if (e.type === "embedding_result") return e.result;
      throw new LLMError("PROVIDER", "Missing embedding result");
    },
    stream<T = unknown>(request: GenerateRequest<T>): StreamResult<T> {
      const abort = new AbortController();
      let used = false,
        result: GenerateResult<T> | undefined,
        error: unknown;
      let resolveDone: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      async function* iterate(): AsyncGenerator<StreamEvent<T>> {
        if (used)
          throw new LLMConfigurationError("Stream can only be consumed once");
        used = true;
        const onAbort = () => abort.abort();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) abort.abort();
        try {
          for await (const e of execute("stream", {
            ...request,
            signal: abort.signal,
          }))
            if (e.type !== "embedding_result") {
              if (e.type === "result") result = e.result;
              yield e;
            }
        } catch (e) {
          error = e;
          throw e;
        } finally {
          request.signal?.removeEventListener("abort", onAbort);
          abort.abort();
          resolveDone!();
        }
      }
      return {
        [Symbol.asyncIterator]: iterate,
        async *textStream() {
          for await (const e of iterate())
            if (e.type === "text_delta") yield e.text;
        },
        async final() {
          if (!used) {
            for await (const _e of iterate()) {
              /* Drain on demand. */
            }
          } else await done;
          if (error) throw error;
          if (!result) throw cancelled();
          return result;
        },
        cancel() {
          abort.abort();
        },
      };
    },
    inspectConfig() {
      return telemetry.sanitize({
        schemaVersion: "1",
        providers: Object.fromEntries(
          Object.entries(config.providers).map(([name, p]) => [
            name,
            {
              adapter: p.name,
              version: p.version,
              capabilities: p.capabilities,
            },
          ]),
        ),
        models: aliases,
        defaults: config.defaults,
        limits: scheduler.limits,
        scopedLimits: config.scopedLimits,
        reliability: {
          timeoutMs: deadline,
          maxAttempts,
          ...config.reliability,
        },
        logging: { payloads: config.logging?.payloads ?? "metadata" },
        prices: config.prices,
      });
    },
    health() {
      return {
        ready: !closed,
        scheduler: scheduler.snapshot(),
        metrics: { ...stats },
        telemetry: { dropped: telemetry.dropped, failures: telemetry.failures },
      };
    },
    flush() {
      return telemetry.flush();
    },
    async close(options: { timeoutMs?: number } = {}) {
      closed = true;
      scheduler.close();
      const end = Date.now() + (options.timeoutMs ?? 5000);
      while (inflight.size && Date.now() < end)
        await new Promise((r) => setTimeout(r, 10));
      for (const controller of inflight) controller.abort(cancelled());
      await telemetry.flush();
    },
  };
  return gateway;
}
export type Gateway = ReturnType<typeof createGateway>;
