import type { AttemptSummary } from "./types.js";
export class LLMError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  requestId?: string;
  traceId?: string;
  attempts: AttemptSummary[] = [];
  partialOutput = false;
  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = `LLM${code
      .split("_")
      .map((x) => x[0] + x.slice(1).toLowerCase())
      .join("")}Error`;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
export class LLMConfigurationError extends LLMError {
  constructor(message: string) {
    super("CONFIGURATION", message);
  }
}
export class LLMValidationError extends LLMError {
  constructor(message = "Output failed schema validation") {
    super("VALIDATION", message);
  }
}
export class LLMUnsupportedFeatureError extends LLMError {
  constructor(feature: string) {
    super("UNSUPPORTED_FEATURE", `Adapter does not support ${feature}`);
  }
}
export function cancelled(): LLMError {
  return new LLMError("CANCELLED", "Request cancelled");
}
export function timeout(phase: string): LLMError {
  return new LLMError("TIMEOUT", `${phase} deadline exceeded`, {
    retryable: false,
  });
}
export function httpError(response: Response): LLMError {
  const s = response.status;
  const retry = response.headers.get("retry-after");
  const retryAfterMs = retry
    ? /^\d+(\.\d+)?$/.test(retry)
      ? Number(retry) * 1000
      : Math.max(0, Date.parse(retry) - Date.now())
    : undefined;
  const code =
    s === 401 || s === 403
      ? "AUTHENTICATION"
      : s === 429
        ? "RATE_LIMIT"
        : s === 413
          ? "CONTEXT_LENGTH"
          : "PROVIDER";
  return new LLMError(code, `Provider returned HTTP ${s}`, {
    status: s,
    retryable: s === 429 || s === 408 || s >= 500,
    retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  });
}
export function normalizeError(error: unknown, signal?: AbortSignal): LLMError {
  if (signal?.aborted)
    return signal.reason instanceof LLMError ? signal.reason : cancelled();
  if (error instanceof LLMError) return error;
  return new LLMError(
    "PROVIDER",
    "Provider transport or response processing failed",
    { retryable: error instanceof TypeError },
  );
}
