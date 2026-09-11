import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../dist/index.js";
import { openai, openaiCompatible } from "../dist/providers/openai.js";
import { anthropic } from "../dist/providers/anthropic.js";
import { gemini } from "../dist/providers/gemini.js";
const request = {
  provider: "p",
  model: "future-model",
  messages: [
    { role: "system", content: "Be precise" },
    { role: "user", content: "Hello" },
  ],
  maxOutputTokens: 32,
};
const fixtures = [
  {
    name: "OpenAI",
    factory: openai,
    response: {
      id: "o",
      choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    stream: [
      { choices: [{ delta: { content: "Hé" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ],
    toolResponse: {
      choices: [
        {
          message: {
            tool_calls: [
              { id: "c", function: { name: "lookup", arguments: '{"q":"x"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    auth: "authorization",
    path: "/v1/chat/completions",
  },
  {
    name: "OpenAI-compatible",
    factory: openaiCompatible,
    response: {
      choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    stream: [
      { choices: [{ delta: { content: "Hé" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ],
    toolResponse: {
      choices: [
        {
          message: {
            tool_calls: [
              { id: "c", function: { name: "lookup", arguments: '{"q":"x"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    auth: "authorization",
    path: "/v1/chat/completions",
  },
  {
    name: "Anthropic",
    factory: anthropic,
    response: {
      id: "a",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    },
    stream: [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hé" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
    ],
    toolResponse: {
      content: [
        { type: "tool_use", id: "c", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
    },
    auth: "x-api-key",
    path: "/v1/messages",
  },
  {
    name: "Gemini",
    factory: gemini,
    response: {
      candidates: [
        { content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
      },
    },
    stream: [
      { candidates: [{ content: { parts: [{ text: "Hé" }] } }] },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        },
      },
    ],
    toolResponse: {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }],
          },
          finishReason: "STOP",
        },
      ],
    },
    auth: "x-goog-api-key",
    path: "/v1/models/future-model:generateContent",
  },
];
function chunks(events) {
  const bytes = new TextEncoder().encode(
    events
      .map((e) => `: comment\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
      .join(""),
  );
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) c.close();
      else c.enqueue(bytes.slice(i, ++i));
    },
  });
}
for (const f of fixtures) {
  test(`${f.name}: shared generation, usage, wire and secret contract`, async () => {
    const events = [];
    let wire;
    const adapter = f.factory({
      apiKey: async () => "PRIVATE_KEY",
      baseURL: "https://provider.invalid/v1",
      query: { api_key: "QUERY_KEY" },
      fetch: async (url, init) => {
        wire = { url: String(url), init, body: JSON.parse(init.body) };
        return Response.json(f.response);
      },
    });
    const g = createGateway({
      providers: { p: adapter },
      logging: { payloads: "full", sink: (e) => events.push(e) },
    });
    const result = await g.generate(request);
    assert.equal(result.text, "Hi");
    assert.equal(result.usage.totalTokens, 12);
    assert.equal(result.finishReason, "stop");
    assert.ok(wire.url.includes(f.path));
    assert.ok(wire.init.headers[f.auth].includes("PRIVATE_KEY"));
    const saved = JSON.stringify(events);
    assert.ok(!saved.includes("PRIVATE_KEY"));
    assert.ok(!saved.includes("QUERY_KEY"));
    await g.close();
  });
  test(`${f.name}: split UTF-8, CRLF stream, final usage and finish`, async () => {
    const g = createGateway({
      providers: {
        p: f.factory({
          apiKey: "x",
          fetch: async () => new Response(chunks(f.stream)),
        }),
      },
    });
    const r = await g.stream(request).final();
    assert.equal(r.text, "Hé");
    assert.equal(r.usage.totalTokens, 12);
    assert.equal(r.finishReason, "stop");
    await g.close();
  });
  test(`${f.name}: tool normalization and native schema mapping`, async () => {
    let wire;
    const g = createGateway({
      providers: {
        p: f.factory({
          apiKey: "x",
          fetch: async (_, init) => {
            wire = JSON.parse(init.body);
            return Response.json(f.toolResponse);
          },
        }),
      },
    });
    const r = await g.generate({
      ...request,
      tools: [
        {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
      jsonSchema: { type: "object" },
    });
    assert.equal(r.toolCalls[0].name, "lookup");
    assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { q: "x" });
    assert.ok(wire.tools);
    if (f.name === "Gemini")
      assert.deepEqual(wire.generationConfig.responseJsonSchema, {
        type: "object",
      });
    else if (f.name === "Anthropic")
      assert.deepEqual(wire.output_config.format.schema, { type: "object" });
    else
      assert.deepEqual(wire.response_format.json_schema.schema, {
        type: "object",
      });
    await g.close();
  });
  test(`${f.name}: normalized HTTP failures exclude provider response secrets`, async () => {
    let calls = 0;
    const g = createGateway({
      providers: {
        p: f.factory({
          apiKey: "x",
          fetch: async () => {
            calls++;
            return new Response("SECRET_PROVIDER_ERROR", { status: 401 });
          },
        }),
      },
    });
    await assert.rejects(
      g.generate(request),
      (e) =>
        e.code === "AUTHENTICATION" &&
        !JSON.stringify(e).includes("SECRET_PROVIDER_ERROR"),
    );
    assert.equal(calls, 1);
    await g.close();
  });
  test(`${f.name}: cancellation closes provider stream`, async () => {
    let cancelled = false;
    const c = new AbortController();
    const g = createGateway({
      providers: {
        p: f.factory({
          apiKey: "x",
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        }),
      },
    });
    const p = g.stream({ ...request, signal: c.signal }).final();
    setTimeout(() => c.abort(), 5);
    await assert.rejects(p, { code: "CANCELLED" });
    assert.equal(cancelled, true);
    assert.equal(g.health().scheduler.active, 0);
    await g.close();
  });
}
test("Anthropic embedding capability rejects without network", async () => {
  let calls = 0;
  const g = createGateway({
    providers: {
      p: anthropic({
        apiKey: "x",
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      }),
    },
  });
  await assert.rejects(g.embed({ provider: "p", model: "x", input: "hi" }), {
    code: "UNSUPPORTED_FEATURE",
  });
  assert.equal(calls, 0);
  await g.close();
});
test("malformed SSE is a normalized failure", async () => {
  const g = createGateway({
    providers: {
      p: openai({
        apiKey: "x",
        fetch: async () => new Response("data: {broken\n\n"),
      }),
    },
  });
  await assert.rejects(g.stream(request).final(), { code: "PROVIDER" });
  await g.close();
});
