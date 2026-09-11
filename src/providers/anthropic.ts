import type {
  ProviderAdapter,
  ProviderOptions,
  GenerateRequest,
  ProviderResult,
  Usage,
} from "../types.js";
import { connection, object, options, sse, usage } from "./shared.js";
import { LLMError, LLMUnsupportedFeatureError } from "../errors.js";
function tokens(u: any): Usage {
  const input =
    u?.input_tokens === undefined
      ? undefined
      : u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
  return {
    ...usage(input, u?.output_tokens, undefined, u),
    cachedInputTokens: u?.cache_read_input_tokens,
  };
}
function finish(value: string): ProviderResult["finishReason"] {
  return value === "end_turn" || value === "stop_sequence"
    ? "stop"
    : value === "max_tokens"
      ? "length"
      : value === "tool_use"
        ? "tool_calls"
        : "unknown";
}
export function anthropic(config: ProviderOptions): ProviderAdapter {
  const c = options(config, "https://api.anthropic.com/v1");
  return {
    name: "anthropic",
    version: "1",
    fetch: c.fetch,
    capabilities: {
      generate: true,
      stream: true,
      tools: true,
      structuredOutput: true,
      embeddings: false,
      vision: true,
    },
    async prepare(canonical) {
      if (canonical.operation === "embed")
        throw new LLMUnsupportedFeatureError("embeddings");
      const r = canonical.request as GenerateRequest;
      const messages = r.messages
        .filter((m) => m.role !== "system")
        .map((m) => {
          if (m.role === "tool")
            return {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: m.toolCallId,
                  content:
                    typeof m.content === "string"
                      ? m.content
                      : JSON.stringify(m.content),
                },
              ],
            };
          const content: unknown[] =
            typeof m.content === "string"
              ? m.content
                ? [{ type: "text", text: m.content }]
                : []
              : m.content.map((p) =>
                  p.type === "image"
                    ? {
                        type: "image",
                        source: p.url
                          ? { type: "url", url: p.url }
                          : {
                              type: "base64",
                              media_type: p.mimeType ?? "image/png",
                              data: p.data,
                            },
                      }
                    : { type: "text", text: p.text },
                );
          for (const t of m.toolCalls ?? [])
            content.push({
              type: "tool_use",
              id: t.id,
              name: t.name,
              input: JSON.parse(t.arguments),
            });
          return { role: m.role, content };
        });
      const systems = r.messages
        .filter((m) => m.role === "system")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n"),
        )
        .join("\n");
      return {
        ...(await connection(c, "/messages", "anthropic")),
        body: {
          ...r.providerOptions?.anthropic,
          model: canonical.model,
          messages,
          max_tokens: r.maxOutputTokens ?? 1024,
          stream: canonical.operation === "stream",
          ...(systems ? { system: systems } : {}),
          ...(r.temperature !== undefined
            ? { temperature: r.temperature }
            : {}),
          ...(r.topP !== undefined ? { top_p: r.topP } : {}),
          ...(r.stop ? { stop_sequences: r.stop } : {}),
          ...(r.tools
            ? {
                tools: r.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
          ...(r.toolChoice
            ? {
                tool_choice:
                  typeof r.toolChoice === "object"
                    ? { type: "tool", name: r.toolChoice.name }
                    : {
                        type:
                          r.toolChoice === "required" ? "any" : r.toolChoice,
                      },
              }
            : {}),
          ...(canonical.jsonSchema !== undefined
            ? {
                output_config: {
                  format: { type: "json_schema", schema: canonical.jsonSchema },
                },
              }
            : {}),
        },
      };
    },
    parse(body) {
      const b = object(body);
      if (!Array.isArray(b.content))
        throw new LLMError("PROVIDER", "Invalid Anthropic response");
      if (b.stop_reason === "refusal")
        throw new LLMError("CONTENT_POLICY", "Provider rejected content");
      const content = b.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => ({ type: "text" as const, text: p.text }));
      return {
        id: b.id,
        content,
        text: content.map((p: any) => p.text).join(""),
        toolCalls: b.content
          .filter((p: any) => p.type === "tool_use")
          .map((p: any) => ({
            id: p.id,
            name: p.name,
            arguments: JSON.stringify(p.input),
          })),
        finishReason: finish(b.stop_reason),
        usage: tokens(b.usage),
        providerMetadata: { responseId: b.id },
      };
    },
    async *parseStream(body, signal) {
      let u: Record<string, unknown> = {};
      for await (const e of sse(body, signal)) {
        if (e.type === "error")
          throw new LLMError("PROVIDER", "Provider returned a stream error");
        if (e.type === "message_start") {
          u = e.message?.usage ?? {};
          yield { type: "usage", usage: tokens(u) };
        }
        if (e.type === "content_block_start") {
          if (e.content_block?.type === "tool_use")
            yield {
              type: "tool_delta",
              index: e.index,
              id: e.content_block.id,
              name: e.content_block.name,
            };
          if (e.content_block?.text)
            yield { type: "text_delta", text: e.content_block.text };
        }
        if (e.type === "content_block_delta") {
          if (e.delta?.text) yield { type: "text_delta", text: e.delta.text };
          if (e.delta?.thinking)
            yield { type: "reasoning_delta", text: e.delta.thinking };
          if (e.delta?.partial_json)
            yield {
              type: "tool_delta",
              index: e.index,
              arguments: e.delta.partial_json,
            };
        }
        if (e.type === "message_delta") {
          u = { ...u, ...e.usage };
          yield { type: "usage", usage: tokens(u) };
          if (e.delta?.stop_reason === "refusal")
            throw new LLMError("CONTENT_POLICY", "Provider rejected content");
          if (e.delta?.stop_reason)
            yield { type: "finish", finishReason: finish(e.delta.stop_reason) };
        }
      }
    },
  };
}
