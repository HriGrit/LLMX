import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as v from "valibot";
import { createGateway } from "../dist/index.js";
import { mockProvider } from "../dist/testing.js";
for (const [name, schema] of [
  ["Zod", z.object({ name: z.string() })],
  ["Valibot", v.object({ name: v.string() })],
]) {
  test(`${name}: real Standard Schema validator accepts and rejects output`, async () => {
    const g = createGateway({
      providers: {
        p: mockProvider([{ text: '{"name":"Ayush"}' }, { text: '{"name":3}' }]),
      },
    });
    const req = {
      provider: "p",
      model: "new-model",
      messages: [{ role: "user", content: "Return JSON" }],
      output: schema,
    };
    assert.deepEqual((await g.generate(req)).data, { name: "Ayush" });
    await assert.rejects(g.generate(req), { code: "VALIDATION" });
    await g.close();
  });
}
