import type { GatewayConfig, RuntimeEvent } from "./types.js";
import { LLMConfigurationError } from "./errors.js";
const sensitive =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|password|secret|token|access_token|refresh_token|cookie|set-cookie|x-goog-api-key)$/i;
export function redactor(paths: string[] = [], maxBytes = 16384) {
  const patterns = paths.map((p) => p.split("."));
  return (input: unknown): unknown => {
    const seen = new WeakSet<object>();
    let budget = maxBytes;
    function walk(value: unknown, path: string[]): unknown {
      if (budget <= 0 || path.length > 24) return "[TRUNCATED]";
      const key = path.at(-1) ?? "";
      if (
        sensitive.test(key) ||
        patterns.some(
          (p) =>
            p.length === path.length &&
            p.every((x, i) => x === "*" || x === path[i]),
        )
      )
        return "[REDACTED]";
      if (typeof value === "function") return "[FUNCTION]";
      if (typeof value === "string") {
        if (/^https?:\/\//i.test(value)) {
          try {
            const url = new URL(value);
            url.username = "";
            url.password = "";
            for (const k of url.searchParams.keys())
              if (sensitive.test(k) || /key|token|secret/i.test(k))
                url.searchParams.set(k, "[REDACTED]");
            value = url.toString();
          } catch {
            /* Treat non-URL as text. */
          }
        }
        const str = value as string;
        const take = Math.max(0, Math.floor(budget / 4));
        budget -= Math.min(str.length, take) * 4;
        return str.length > take ? str.slice(0, take) + "[TRUNCATED]" : str;
      }
      budget -= 16;
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[CIRCULAR]";
        seen.add(value);
        if (Array.isArray(value))
          return value
            .slice(0, 1000)
            .map((v, i) => walk(v, [...path, String(i)]));
        const out: Record<string, unknown> = Object.create(null);
        for (const [k, v] of Object.entries(value)) {
          if (budget <= 0) {
            out._truncated = true;
            break;
          }
          out[k] = walk(v, [...path, k]);
        }
        return out;
      }
      return value;
    }
    return walk(input, []);
  };
}
export class Telemetry {
  private queue: RuntimeEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  dropped = 0;
  failures = 0;
  readonly sanitize: (value: unknown) => unknown;
  constructor(private config: GatewayConfig) {
    this.sanitize = redactor(
      config.logging?.redact,
      config.logging?.maxPayloadBytes,
    );
    for (const [key, value] of Object.entries(config.telemetry ?? {}))
      if (typeof value === "number" && (!Number.isFinite(value) || value <= 0))
        throw new LLMConfigurationError(`Invalid telemetry ${key}`);
  }
  emit(event: RuntimeEvent) {
    const mode = this.config.logging?.payloads ?? "metadata";
    const attributes = { ...event.attributes };
    if (mode !== "full")
      for (const k of ["logical", "canonical", "wire", "raw", "normalized"])
        delete attributes[k];
    const clean = {
      ...event,
      attributes: this.sanitize(attributes) as Record<string, unknown>,
    };
    if (mode !== "none")
      try {
        this.config.logging?.sink?.(clean);
      } catch {
        this.failures++;
      }
    if (!this.config.telemetry?.exporters?.length) return;
    if (this.queue.length >= (this.config.telemetry.maxQueueSize ?? 1000)) {
      this.dropped++;
      return;
    }
    this.queue.push(clean);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.config.telemetry.flushIntervalMs ?? 1000);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async drain() {
    const count = this.queue.length;
    for (let sent = 0; sent < count;) {
      const batch = this.queue.splice(
        0,
        this.config.telemetry?.batchSize ?? 100,
      );
      if (!batch.length) break;
      sent += batch.length;
      await Promise.all(
        (this.config.telemetry?.exporters ?? []).map(async (exporter) => {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() =>
                exporter.export(batch, controller.signal),
              ),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error("Export timeout"));
                }, this.config.telemetry?.exportTimeoutMs ?? 2000);
              }),
            ]);
          } catch {
            this.failures++;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
    }
  }
}
