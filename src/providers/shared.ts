import type { ProviderOptions, Usage } from "../types.js";
import { LLMConfigurationError, LLMError, normalizeError } from "../errors.js";
export function options(config: ProviderOptions, defaultURL: string) {
  const url = new URL(config.baseURL ?? defaultURL);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new LLMConfigurationError(
      "Provider URL must be HTTP(S) without embedded credentials",
    );
  if (typeof config.apiKey !== "function" && !config.apiKey)
    throw new LLMConfigurationError("Provider apiKey is required");
  return {
    ...config,
    baseURL: url.toString().replace(/\/$/, ""),
    headers: { ...config.headers },
    query: { ...config.query },
  };
}
export async function connection(
  config: ReturnType<typeof options>,
  path: string,
  auth: "bearer" | "anthropic" | "google" = "bearer",
) {
  const secret =
    typeof config.apiKey === "function" ? await config.apiKey() : config.apiKey;
  if (!secret)
    throw new LLMError(
      "AUTHENTICATION",
      "Credential callback returned an empty key",
    );
  const url = new URL(config.baseURL + path);
  for (const [k, v] of Object.entries(config.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...config.headers,
  };
  if (auth === "bearer") headers.authorization = `Bearer ${secret}`;
  if (auth === "anthropic") {
    headers["x-api-key"] = secret;
    headers["anthropic-version"] ??= "2023-06-01";
  }
  if (auth === "google") headers["x-goog-api-key"] = secret;
  return { url: url.toString(), method: "POST" as const, headers };
}
export function usage(
  input?: number,
  output?: number,
  total?: number,
  details?: Record<string, unknown>,
): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      total ??
      (input !== undefined && output !== undefined
        ? input + output
        : undefined),
    source:
      input !== undefined || output !== undefined || total !== undefined
        ? "provider"
        : "unknown",
    details,
  };
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LLMError("PROVIDER", "Invalid provider response");
  return value as Record<string, any>;
}
/** Incremental SSE parser handles CRLF, split UTF-8 and multi-line data with bounded frames. */
export async function* sse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Record<string, any>> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    data: string[] = [],
    bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  function parse(line: string): Record<string, any> | undefined {
    if (line === "") {
      const joined = data.join("\n");
      data = [];
      bytes = 0;
      if (!joined || joined === "[DONE]") return;
      try {
        return object(JSON.parse(joined));
      } catch {
        throw new LLMError("PROVIDER", "Malformed SSE event");
      }
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
      bytes += line.length;
      if (bytes > 1048576)
        throw new LLMError("PROVIDER", "SSE frame exceeded 1 MiB");
    }
  }
  try {
    while (true) {
      if (signal.aborted) throw normalizeError(undefined, signal);
      const next = await reader.read();
      pending += decoder.decode(next.value, { stream: !next.done });
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        const event = parse(line);
        if (event) yield event;
      }
      if (pending.length > 1048576)
        throw new LLMError("PROVIDER", "SSE line exceeded 1 MiB");
      if (next.done) {
        if (pending) parse(pending.replace(/\r$/, ""));
        const event = parse("");
        if (event) yield event;
        break;
      }
    }
    if (signal.aborted) throw normalizeError(undefined, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
