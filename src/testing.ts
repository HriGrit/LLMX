import type {
  ProviderAdapter,
  ProviderResult,
  ProviderEvent,
} from "./types.js";
import { openaiCompatible } from "./providers/openai.js";
export interface MockOptions {
  text?: string;
  usage?: ProviderResult["usage"];
  toolCalls?: ProviderResult["toolCalls"];
  events?: ProviderEvent[];
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
  onRequest?: (url: string, init?: RequestInit) => void;
}
/** Script successive transport responses without credentials or external network access. */
export function mockProvider(
  script: MockOptions[] = [{ text: "Hello" }],
): ProviderAdapter {
  let index = 0;
  const base = openaiCompatible({
    apiKey: "mock",
    baseURL: "https://mock.invalid/v1",
  });
  return {
    ...base,
    name: "mock",
    async fetch(url, init) {
      const item = script[Math.min(index++, script.length - 1)] ?? {};
      item.onRequest?.(String(url), init);
      if (item.delayMs)
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, item.delayMs);
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      if (item.status && item.status >= 400)
        return new Response("{}", {
          status: item.status,
          headers: item.headers,
        });
      const r = JSON.parse(String(init?.body));
      if (String(url).endsWith("/embeddings"))
        return Response.json({
          data: (Array.isArray(r.input) ? r.input : [r.input]).map(
            (_: unknown, i: number) => ({ index: i, embedding: [0.1, 0.2] }),
          ),
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      const u = item.usage ?? {
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        source: "provider",
      };
      if (r.stream) {
        const events = item.events ?? [
          { type: "text_delta", text: item.text ?? "Hello" },
          { type: "usage", usage: u },
          { type: "finish", finishReason: "stop" },
        ];
        return new Response(
          events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "mock-response",
        choices: [
          {
            message: {
              content: item.text ?? "Hello",
              tool_calls: item.toolCalls?.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: t.arguments },
              })),
            },
            finish_reason: item.toolCalls?.length ? "tool_calls" : "stop",
          },
        ],
        usage:
          u.source === "unknown"
            ? undefined
            : {
                prompt_tokens: u.inputTokens,
                completion_tokens: u.outputTokens,
                total_tokens: u.totalTokens,
              },
      });
    },
    async *parseStream(body, signal) {
      const { sse } = await import("./providers/shared.js");
      for await (const e of sse(body, signal)) yield e as ProviderEvent;
    },
  };
}
