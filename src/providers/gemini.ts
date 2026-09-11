import type {
  ProviderAdapter,
  ProviderOptions,
  GenerateRequest,
  EmbedRequest,
  ProviderResult,
  Usage,
} from "../types.js";
import { connection, object, options, sse, usage } from "./shared.js";
import { LLMError, LLMConfigurationError } from "../errors.js";
function tokens(u: any): Usage {
  return {
    ...usage(
      u?.promptTokenCount,
      u?.candidatesTokenCount === undefined
        ? undefined
        : u.candidatesTokenCount + (u?.thoughtsTokenCount ?? 0),
      u?.totalTokenCount,
      u,
    ),
    cachedInputTokens: u?.cachedContentTokenCount,
    reasoningTokens: u?.thoughtsTokenCount,
  };
}
function finish(value: string): ProviderResult["finishReason"] {
  return value === "STOP"
    ? "stop"
    : value === "MAX_TOKENS"
      ? "length"
      : ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT"].includes(value)
        ? "content_filter"
        : "unknown";
}
export function gemini(config: ProviderOptions): ProviderAdapter {
  const c = options(config, "https://generativelanguage.googleapis.com/v1beta");
  return {
    name: "gemini",
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
      const model = `models/${encodeURIComponent(canonical.model.replace(/^models\//, ""))}`;
      if (canonical.operation === "embed") {
        const r = canonical.request as EmbedRequest,
          inputs = typeof r.input === "string" ? [r.input] : r.input;
        return {
          ...(await connection(c, `/${model}:batchEmbedContents`, "google")),
          body: {
            requests: inputs.map((input) => ({
              ...r.providerOptions?.gemini,
              model: `models/${canonical.model.replace(/^models\//, "")}`,
              content: { parts: [{ text: input }] },
              outputDimensionality: r.dimensions,
            })),
          },
        };
      }
      const r = canonical.request as GenerateRequest;
      const contents = r.messages
        .filter((m) => m.role !== "system")
        .map((m) => {
          if (m.role === "tool") {
            if (!m.name)
              throw new LLMConfigurationError(
                "Gemini tool results require message.name",
              );
            return {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: m.name,
                    response: { result: m.content },
                  },
                },
              ],
            };
          }
          const parts: unknown[] =
            typeof m.content === "string"
              ? m.content
                ? [{ text: m.content }]
                : []
              : m.content.map((p) =>
                  p.type === "image"
                    ? p.url
                      ? {
                          fileData: {
                            fileUri: p.url,
                            mimeType: p.mimeType ?? "image/png",
                          },
                        }
                      : {
                          inlineData: {
                            data: p.data,
                            mimeType: p.mimeType ?? "image/png",
                          },
                        }
                    : { text: p.text },
                );
          for (const t of m.toolCalls ?? [])
            parts.push({
              functionCall: { name: t.name, args: JSON.parse(t.arguments) },
            });
          return { role: m.role === "assistant" ? "model" : "user", parts };
        });
      const systems = r.messages
        .filter((m) => m.role === "system")
        .map((m) => ({
          text:
            typeof m.content === "string"
              ? m.content
              : m.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n"),
        }));
      const extra = r.providerOptions?.gemini ?? {};
      const wire = await connection(
        c,
        `/${model}:${canonical.operation === "stream" ? "streamGenerateContent" : "generateContent"}`,
        "google",
      );
      if (canonical.operation === "stream") {
        const url = new URL(wire.url);
        url.searchParams.set("alt", "sse");
        wire.url = url.toString();
      }
      return {
        ...wire,
        body: {
          ...extra,
          contents,
          ...(systems.length ? { systemInstruction: { parts: systems } } : {}),
          generationConfig: {
            ...(extra.generationConfig as object),
            ...(r.maxOutputTokens !== undefined
              ? { maxOutputTokens: r.maxOutputTokens }
              : {}),
            ...(r.temperature !== undefined
              ? { temperature: r.temperature }
              : {}),
            ...(r.topP !== undefined ? { topP: r.topP } : {}),
            ...(r.stop ? { stopSequences: r.stop } : {}),
            ...(canonical.jsonSchema !== undefined
              ? {
                  responseMimeType: "application/json",
                  responseJsonSchema: canonical.jsonSchema,
                }
              : {}),
          },
          ...(r.tools
            ? {
                tools: [
                  {
                    functionDeclarations: r.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.parameters,
                    })),
                  },
                ],
              }
            : {}),
          ...(r.toolChoice
            ? {
                toolConfig: {
                  functionCallingConfig:
                    typeof r.toolChoice === "object"
                      ? {
                          mode: "ANY",
                          allowedFunctionNames: [r.toolChoice.name],
                        }
                      : {
                          mode:
                            r.toolChoice === "required"
                              ? "ANY"
                              : r.toolChoice.toUpperCase(),
                        },
                },
              }
            : {}),
        },
      };
    },
    parse(body) {
      const b = object(body),
        candidate = b.candidates?.[0];
      if (
        b.promptFeedback?.blockReason ||
        finish(candidate?.finishReason) === "content_filter"
      )
        throw new LLMError("CONTENT_POLICY", "Provider rejected content");
      if (!candidate)
        throw new LLMError("PROVIDER", "Missing Gemini candidate");
      const parts = candidate.content?.parts ?? [],
        content = parts
          .filter((p: any) => p.text && !p.thought)
          .map((p: any) => ({ type: "text" as const, text: p.text }));
      const toolCalls = parts
        .filter((p: any) => p.functionCall)
        .map((p: any, i: number) => ({
          id: p.functionCall.id ?? `call_${i}`,
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        }));
      return {
        content,
        text: content.map((p: any) => p.text).join(""),
        toolCalls,
        finishReason: toolCalls.length
          ? "tool_calls"
          : finish(candidate.finishReason),
        usage: tokens(b.usageMetadata),
        providerMetadata: {
          responseId: b.responseId,
          modelVersion: b.modelVersion,
        },
      };
    },
    parseEmbedding(body) {
      const b = object(body);
      if (!Array.isArray(b.embeddings))
        throw new LLMError("PROVIDER", "Invalid embedding response");
      return {
        embeddings: b.embeddings.map((e: any) => e.values),
        usage: { source: "unknown" },
      };
    },
    async *parseStream(body, signal) {
      let toolIndex = 0;
      for await (const b of sse(body, signal)) {
        const candidate = b.candidates?.[0];
        if (b.error)
          throw new LLMError("PROVIDER", "Provider returned a stream error");
        if (
          b.promptFeedback?.blockReason ||
          finish(candidate?.finishReason) === "content_filter"
        )
          throw new LLMError("CONTENT_POLICY", "Provider rejected content");
        for (const p of candidate?.content?.parts ?? []) {
          if (p.text)
            yield {
              type: p.thought ? "reasoning_delta" : "text_delta",
              text: p.text,
            };
          if (p.functionCall) {
            const i = toolIndex++;
            yield {
              type: "tool_delta",
              index: i,
              id: p.functionCall.id ?? `call_${i}`,
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args ?? {}),
            };
          }
        }
        if (b.usageMetadata)
          yield { type: "usage", usage: tokens(b.usageMetadata) };
        if (candidate?.finishReason)
          yield {
            type: "finish",
            finishReason: toolIndex
              ? "tool_calls"
              : finish(candidate.finishReason),
          };
      }
    },
  };
}
