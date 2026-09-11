import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway, validateOutput } from "../dist/index.js";
import { mockProvider } from "../dist/testing.js";
const request = {
  model: "main_model",
  messages: [{ role: "user", content: "SECRET_PROMPT" }],
};
const gateway = (script, config = {}) =>
  createGateway({
    providers: { primary: mockProvider(script) },
    models: { main_model: { provider: "primary", model: "brand-new-model" } },
    ...config,
  });
test("aliases and direct model strings work without a catalogue", async () => {
  const g = gateway();
  assert.equal((await g.generate(request)).model, "brand-new-model");
  assert.equal(
    (
      await g.generate({
        ...request,
        provider: "primary",
        model: "future-model",
      })
    ).model,
    "future-model",
  );
  await g.close();
});
test("initialization is network free and validates alias cycles and missing providers", () => {
  let calls = 0;
  gateway([{ onRequest: () => calls++ }]);
  assert.equal(calls, 0);
  assert.throws(
    () => gateway([], { models: { x: { provider: "missing", model: "x" } } }),
    { code: "CONFIGURATION" },
  );
  assert.throws(
    () =>
      gateway([], {
        models: {
          a: { provider: "primary", model: "x", fallback: ["b"] },
          b: { provider: "primary", model: "x", fallback: ["a"] },
        },
      }),
    { code: "CONFIGURATION" },
  );
});
test("config snapshot is unaffected by mutations to caller alias config", async () => {
  const models = { main_model: { provider: "primary", model: "original" } };
  const g = gateway([], { models });
  models.main_model.model = "mutated";
  assert.equal((await g.generate(request)).model, "original");
  await g.close();
});
test("authentication and permanent 400 failures never retry", async () => {
  for (const status of [400, 401, 403]) {
    let count = 0;
    const g = gateway([{ status, onRequest: () => count++ }]);
    await assert.rejects(g.generate(request), (e) => {
      assert.equal(e.attempts.length, 1);
      assert.ok(e.requestId);
      assert.ok(e.traceId);
      return true;
    });
    assert.equal(count, 1);
    await g.close();
  }
});
test("429 retries consume attempt budget and are visible", async () => {
  const g = gateway([
    { status: 429, headers: { "retry-after": "0" } },
    { text: "ok" },
  ]);
  const r = await g.generate(request);
  assert.equal(r.text, "ok");
  assert.equal(r.attempts.length, 2);
  assert.equal(g.health().metrics.retries, 1);
  await g.close();
});
test("explicit fallback changes model only for eligible transient failures", async () => {
  const g = createGateway({
    providers: {
      primary: mockProvider([{ status: 503 }]),
      backup: mockProvider([{ text: "backup" }]),
    },
    models: {
      main_model: {
        provider: "primary",
        model: "a",
        fallback: ["backup_model"],
      },
      backup_model: { provider: "backup", model: "b" },
    },
    random: () => 0,
  });
  const r = await g.generate(request);
  assert.equal(r.provider, "backup");
  assert.equal(r.attempts.length, 2);
  await g.close();
});
test("aborting a provider request releases concurrency", async () => {
  const g = gateway([{ delayMs: 1000 }]);
  const c = new AbortController();
  const p = g.generate({ ...request, signal: c.signal });
  setTimeout(() => c.abort(), 5);
  await assert.rejects(p, { code: "CANCELLED" });
  assert.equal(g.health().scheduler.active, 0);
  await g.close();
});
test("total deadline also bounds a transport that ignores AbortSignal", async () => {
  const provider = { ...mockProvider(), fetch: () => new Promise(() => {}) };
  const g = gateway([], {
    providers: { primary: provider },
    reliability: { timeoutMs: 10 },
  });
  await assert.rejects(g.generate(request), { code: "TIMEOUT" });
  assert.equal(g.health().scheduler.active, 0);
  await g.close();
});
test("structured output validates raw JSON Schema without coercion", async () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  };
  const g = gateway([{ text: '{"count":2}' }, { text: '{"count":"2"}' }]);
  assert.deepEqual((await g.generate({ ...request, output: schema })).data, {
    count: 2,
  });
  await assert.rejects(g.generate({ ...request, output: schema }), {
    code: "VALIDATION",
  });
  await g.close();
});
test("custom and Standard Schema validation adapters work", async () => {
  assert.equal(await validateOutput("2", { parse: (x) => x * 2 }), 4);
  assert.equal(
    await validateOutput("2", {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (x) => ({ value: x }),
      },
    }),
    2,
  );
  await assert.rejects(
    validateOutput("2", {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: ["no"] }),
      },
    }),
    { code: "VALIDATION" },
  );
});
test("unsupported JSON Schema constraints fail before transport", async () => {
  let count = 0;
  const g = gateway([{ onRequest: () => count++ }]);
  await assert.rejects(
    g.generate({ ...request, output: { type: "string", pattern: "^x" } }),
    { code: "CONFIGURATION" },
  );
  assert.equal(count, 0);
  await g.close();
});
test("metadata logging never stores prompt or response", async () => {
  const events = [];
  const g = gateway([{ text: "SECRET_RESPONSE" }], {
    logging: { sink: (e) => events.push(e) },
  });
  await g.generate(request);
  assert.ok(events.length);
  const text = JSON.stringify(events);
  assert.ok(!text.includes("SECRET_PROMPT"));
  assert.ok(!text.includes("SECRET_RESPONSE"));
  await g.close();
});
test("full inspection redacts credentials and contains exact serialized body", async () => {
  const events = [];
  let body;
  const g = gateway(
    [{ onRequest: (_, init) => (body = JSON.parse(init.body)) }],
    { logging: { payloads: "full", sink: (e) => events.push(e) } },
  );
  await g.generate(request);
  const wire = events.find((e) => e.type === "attempt.start").attributes.wire;
  assert.deepEqual(JSON.parse(JSON.stringify(wire.body)), body);
  assert.equal(wire.headers.authorization, "[REDACTED]");
  await g.close();
});
test("usage and prices produce explicit cost; unknown usage never becomes zero", async () => {
  const g = gateway(
    [
      {
        usage: {
          source: "provider",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
      { usage: { source: "unknown" } },
    ],
    {
      prices: {
        "primary/brand-new-model": { inputPerMillion: 1, outputPerMillion: 2 },
      },
    },
  );
  assert.equal((await g.generate(request)).cost.amount, 0.00002);
  assert.equal((await g.generate(request)).cost, undefined);
  await g.close();
});
test("embedding normalization is behind the same runtime controls", async () => {
  const g = gateway();
  const r = await g.embed({ model: "main_model", input: ["a", "b"] });
  assert.equal(r.embeddings.length, 2);
  assert.equal(r.usage.totalTokens, 5);
  await g.close();
});
test("stream final drains lazily and textStream composes a final result", async () => {
  const g = gateway([{ text: "Hello" }]);
  const stream = g.stream(request);
  let text = "";
  for await (const t of stream.textStream()) text += t;
  assert.equal(text, "Hello");
  assert.equal((await stream.final()).text, "Hello");
  assert.equal((await g.stream(request).final()).text, "Hello");
  await g.close();
});
test("partial stream is never retried and error exposes partialOutput", async () => {
  let calls = 0;
  const g = gateway([
    {
      events: [{ type: "text_delta", text: "partial" }],
      onRequest: () => calls++,
    },
  ]);
  await assert.rejects(
    g.stream(request).final(),
    (e) => e.partialOutput && e.attempts.length === 1,
  );
  assert.equal(calls, 1);
  await g.close();
});
test("breaking stream consumption releases capacity", async () => {
  const g = gateway();
  for await (const e of g.stream(request)) {
    assert.equal(e.type, "text_delta");
    break;
  }
  assert.equal(g.health().scheduler.active, 0);
  await g.close();
});
test("stream fragments assemble tool arguments", async () => {
  const g = gateway([
    {
      events: [
        {
          type: "tool_delta",
          index: 0,
          id: "t",
          name: "get",
          arguments: '{"x":',
        },
        { type: "tool_delta", index: 0, arguments: "1}" },
        { type: "finish", finishReason: "tool_calls" },
      ],
    },
  ]);
  const r = await g.stream(request).final();
  assert.deepEqual(r.toolCalls, [
    { id: "t", name: "get", arguments: '{"x":1}' },
  ]);
  await g.close();
});
test("exporter failures are isolated and buffers bounded", async () => {
  const g = gateway([], {
    telemetry: {
      maxQueueSize: 2,
      exporters: [
        {
          export() {
            throw new Error("fail");
          },
        },
      ],
    },
  });
  await g.generate(request);
  await g.flush();
  assert.ok(g.health().telemetry.failures > 0);
  assert.ok(g.health().telemetry.dropped > 0);
  await g.close();
});
test("close rejects subsequent calls and shutdown can cancel hanging work", async () => {
  const g = gateway([{ delayMs: 1000 }]);
  const p = g.generate(request);
  const check = assert.rejects(p, { code: "CANCELLED" });
  await g.close({ timeoutMs: 0 });
  await check;
  await assert.rejects(g.generate(request), { code: "CANCELLED" });
});
