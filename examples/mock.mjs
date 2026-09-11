import { createGateway } from "../dist/index.js";
import { mockProvider } from "../dist/testing.js";
const llm = createGateway({
  providers: { local: mockProvider([{ text: "LLMX is ready." }]) },
  models: { main_model: { provider: "local", model: "any-model-name" } },
});
try {
  const result = await llm.generate({
    model: "main_model",
    messages: [{ role: "user", content: "Hello" }],
  });
  console.log(result.text, result.usage);
  const stream = llm.stream({
    model: "main_model",
    messages: [{ role: "user", content: "Hello" }],
  });
  for await (const text of stream.textStream()) process.stdout.write(text);
  console.log("\n", (await stream.final()).timing);
} finally {
  await llm.close();
}
