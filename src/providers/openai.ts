import type {
  ProviderAdapter,
  ProviderOptions,
  GenerateRequest,
  EmbedRequest,
  ProviderResult,
  Usage,
} from "../types.js";
import { connection, object, options, sse, usage } from "./shared.js";
import { LLMError } from "../errors.js";
function tokens(u: any): Usage {
  return {
    ...usage(u?.prompt_tokens, u?.completion_tokens, u?.total_tokens, u),
    cachedInputTokens: u?.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens,
  };
}
function finish(value: string): ProviderResult["finishReason"] {
  return ["stop", "length", "tool_calls", "content_filter"].includes(value)
    ? (value as ProviderResult["finishReason"])
    : "unknown";
}
export function openai(config: ProviderOptions): ProviderAdapter {
  return openaiCompatible(config, "openai");
}
export function openaiCompatible(
  config: ProviderOptions,
  name = "openai-compatible",
): ProviderAdapter {
  const c = options(config, "https://api.openai.com/v1");
  return {
    name,
    version: "1",
    fetch: c.fetch,
    capabilities: {
      generate: true,
      stream: true,
      tools: true,
      structuredOutput: true,
      embeddings: true,
      vision: true,
    },
    async prepare(canonical) {
      const req = canonical.request;
      const extra =
        req.providerOptions?.[name] ?? req.providerOptions?.openai ?? {};
      if (canonical.operation === "embed") {
        const r = req as EmbedRequest;
        return {
          ...(await connection(c, "/embeddings")),
          body: {
            ...extra,
            model: canonical.model,
            input: r.input,
            dimensions: r.dimensions,
            encoding_format: "float",
          },
        };
      }
      const r = req as GenerateRequest,
        streaming = canonical.operation === "stream";
      const messages = r.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((p) =>
                p.type === "image"
                  ? {
                      type: "image_url",
                      image_url: {
                        url:
                          p.url ??
                          `data:${p.mimeType ?? "image/png"};base64,${p.data}`,
                      },
                    }
                  : { type: "text", text: p.text },
              ),
        tool_calls: m.toolCalls?.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        })),
        tool_call_id: m.toolCallId,
        name: m.name,
      }));
      return {
        ...(await connection(c, "/chat/completions")),
        body: {
          ...extra,
          model: canonical.model,
          messages,
          stream: streaming,
          ...(streaming ? { stream_options: { include_usage: true } } : {}),
          ...(r.maxOutputTokens !== undefined
            ? { max_completion_tokens: r.maxOutputTokens }
            : {}),
          ...(r.temperature !== undefined
            ? { temperature: r.temperature }
            : {}),
          ...(r.topP !== undefined ? { top_p: r.topP } : {}),
          ...(r.stop ? { stop: r.stop } : {}),
          ...(r.tools
            ? {
                tools: r.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
          ...(r.toolChoice
            ? {
                tool_choice:
                  typeof r.toolChoice === "string"
                    ? r.toolChoice
                    : {
                        type: "function",
                        function: { name: r.toolChoice.name },
                      },
              }
            : {}),
          ...(canonical.jsonSchema !== undefined
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "output",
                    strict: true,
                    schema: canonical.jsonSchema,
                  },
                },
              }
            : {}),
        },
      };
    },
    parse(body) {
      const b = object(body),
        choice = b.choices?.[0],
        m = choice?.message;
      if (!m) throw new LLMError("PROVIDER", "Missing response message");
      if (m.refusal || choice.finish_reason === "content_filter")
        throw new LLMError("CONTENT_POLICY", "Provider rejected content");
      const text = m.content ?? "";
      if (typeof text !== "string")
        throw new LLMError("PROVIDER", "Invalid response content");
      return {
        id: b.id,
        text,
        content: text ? [{ type: "text", text }] : [],
        toolCalls: (m.tool_calls ?? []).map((t: any) => ({
          id: t.id,
          name: t.function.name,
          arguments: t.function.arguments,
        })),
        finishReason: finish(choice.finish_reason),
        usage: tokens(b.usage),
        providerMetadata: {
          responseId: b.id,
          systemFingerprint: b.system_fingerprint,
        },
      };
    },
    parseEmbedding(body) {
      const b = object(body);
      if (!Array.isArray(b.data))
        throw new LLMError("PROVIDER", "Invalid embedding response");
      return {
        embeddings: [...b.data]
          .sort((a: any, b: any) => a.index - b.index)
          .map((x: any) => x.embedding),
        usage: usage(
          b.usage?.prompt_tokens,
          undefined,
          b.usage?.total_tokens,
          b.usage,
        ),
      };
    },
    async *parseStream(body, signal) {
      for await (const b of sse(body, signal)) {
        if (b.error)
          throw new LLMError("PROVIDER", "Provider returned a stream error");
        const choice = b.choices?.[0],
          delta = choice?.delta;
        if (delta?.refusal || choice?.finish_reason === "content_filter")
          throw new LLMError("CONTENT_POLICY", "Provider rejected content");
        if (delta?.content) yield { type: "text_delta", text: delta.content };
        if (delta?.reasoning_content)
          yield { type: "reasoning_delta", text: delta.reasoning_content };
        for (const t of delta?.tool_calls ?? [])
          yield {
            type: "tool_delta",
            index: t.index,
            id: t.id,
            name: t.function?.name,
            arguments: t.function?.arguments,
          };
        if (b.usage) yield { type: "usage", usage: tokens(b.usage) };
        if (choice?.finish_reason)
          yield { type: "finish", finishReason: finish(choice.finish_reason) };
      }
    },
  };
}
