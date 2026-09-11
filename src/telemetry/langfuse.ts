import type { Exporter, RuntimeEvent } from "../types.js";
import { LLMConfigurationError } from "../errors.js";
/** Optional HTTP ingestion exporter. Importing or creating it performs no network I/O. */
export function langfuse(config: {
  publicKey: string;
  secretKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): Exporter {
  if (!config.publicKey || !config.secretKey)
    throw new LLMConfigurationError(
      "Langfuse publicKey and secretKey are required",
    );
  const endpoint = new URL(
    "/api/public/ingestion",
    config.baseURL ?? "https://cloud.langfuse.com",
  );
  return {
    async export(events: readonly RuntimeEvent[], signal) {
      const batch = events
        .filter(
          (e) =>
            e.type === "request.start" ||
            e.type === "request.end" ||
            e.type === "attempt.start" ||
            e.type === "attempt.end",
        )
        .map((e) => {
          const start = e.type.endsWith("start"),
            generation = e.type.startsWith("attempt");
          if (!generation)
            return {
              id: crypto.randomUUID(),
              timestamp: new Date(e.timestamp).toISOString(),
              type: "trace-create",
              body: {
                id: e.traceId,
                name: "llmx.request",
                metadata: { requestId: e.requestId, ...e.attributes },
              },
            };
          return {
            id: crypto.randomUUID(),
            timestamp: new Date(e.timestamp).toISOString(),
            type: start ? "generation-create" : "generation-update",
            body: {
              id: e.spanId,
              traceId: e.traceId,
              name: "llmx.provider",
              ...(start
                ? {
                    startTime: new Date(e.timestamp).toISOString(),
                    model: e.attributes.model,
                  }
                : {
                    endTime: new Date(e.timestamp).toISOString(),
                    level:
                      e.attributes.status === "error" ? "ERROR" : "DEFAULT",
                  }),
              metadata: e.attributes,
            },
          };
        });
      if (!batch.length) return;
      const result = await (config.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${btoa(`${config.publicKey}:${config.secretKey}`)}`,
        },
        body: JSON.stringify({ batch }),
        signal,
      });
      if (!result.ok) {
        void result.body?.cancel();
        throw new Error(`Langfuse export returned HTTP ${result.status}`);
      }
      const body = (await result.json()) as { errors?: unknown[] };
      if (body.errors?.length)
        throw new Error("Langfuse rejected ingestion events");
    },
  };
}
