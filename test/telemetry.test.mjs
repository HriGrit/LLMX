import { test } from "node:test";
import assert from "node:assert/strict";
import { langfuse } from "../dist/telemetry/langfuse.js";
import { redactor } from "../dist/telemetry.js";
const event = (type, attributes = {}) => ({
  schemaVersion: "1",
  type,
  timestamp: 1000,
  requestId: "request",
  traceId: "trace",
  spanId: "attempt",
  attributes,
});
test("Langfuse exports trace/generation events to configured endpoint", async () => {
  let call;
  const exporter = langfuse({
    publicKey: "public",
    secretKey: "secret",
    baseURL: "https://lf.invalid",
    fetch: async (url, init) => {
      call = { url: String(url), init, body: JSON.parse(init.body) };
      return Response.json({ successes: [], errors: [] });
    },
  });
  await exporter.export([
    event("request.start"),
    event("attempt.start", { model: "x" }),
    event("attempt.end", { status: "success" }),
    event("request.end"),
  ]);
  assert.equal(call.url, "https://lf.invalid/api/public/ingestion");
  assert.equal(call.body.batch.length, 4);
  assert.equal(call.body.batch[1].type, "generation-create");
  assert.equal(call.body.batch[2].type, "generation-update");
  assert.equal(call.body.batch[2].body.id, "attempt");
  assert.ok(call.init.headers.authorization.startsWith("Basic "));
});
test("Langfuse detects partial ingestion failure even on HTTP success", async () => {
  const exporter = langfuse({
    publicKey: "public",
    secretKey: "secret",
    fetch: async () => Response.json({ errors: [{ message: "bad" }] }),
  });
  await assert.rejects(exporter.export([event("request.start")]));
});
test("redaction handles header case, query secrets, nested custom paths, and cycles", () => {
  const record = {
    headers: { Authorization: "one", Cookie: "two" },
    url: "https://x.invalid?api_key=three",
    customer: { email: "private" },
  };
  record.self = record;
  const text = JSON.stringify(redactor(["customer.email"])(record));
  for (const value of ["one", "two", "three", "private"])
    assert.ok(!text.includes(value));
  assert.ok(text.includes("[CIRCULAR]"));
});
test("redaction bounds oversized nested records", () => {
  const text = JSON.stringify(
    redactor([], 1024)({ payload: "x".repeat(10000) }),
  );
  assert.ok(text.length < 1200);
  assert.ok(text.includes("TRUNCATED"));
});
