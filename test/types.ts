import { createGateway, type GenerateResult } from "../src/index.js";
import { mockProvider } from "../src/testing.js";
import { z } from "zod";
import * as v from "valibot";
const gateway = createGateway({ providers: { mock: mockProvider() } });
const req = {
  provider: "mock",
  model: "any-future-model",
  messages: [{ role: "user" as const, content: "hello" }],
};
const zodResult: Promise<GenerateResult<{ name: string }>> = gateway.generate({
  ...req,
  output: z.object({ name: z.string() }),
});
const valibotResult: Promise<GenerateResult<{ name: string }>> =
  gateway.generate({ ...req, output: v.object({ name: v.string() }) });
void zodResult;
void valibotResult;
gateway.generate({
  ...req,
  // @ts-expect-error Unknown message roles are rejected.
  messages: [{ role: "developer-mistake", content: "hello" }],
});
// @ts-expect-error Token limits are numeric.
gateway.generate({ ...req, maxOutputTokens: "100" });
