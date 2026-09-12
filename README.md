# LLMX

A lightweight TypeScript runtime for executing LLM API calls with consistent scheduling, retries, validation, wire inspection, usage accounting, and tracing.

**Status: initial v0.1 implementation, not yet published to npm.** The repository implements the local runtime slice of the product requirements. Production controls and remaining release gates are tracked in [scope](docs/SCOPE.md). No model rankings, automatic model recommendations, mandatory proxy, or mandatory infrastructure.

## Run locally

Requires Node.js 22 or newer.

```sh
git clone https://github.com/HriGrit/LLMX.git
cd LLMX
npm ci
npm test
npm run benchmark
npm pack
```

Install the resulting `ayushsoam51-llmx-0.1.0.tgz` into your application. The package is published under Ayush's verified npm scope: `@ayushsoam51/llmx`.

The core has **zero runtime dependencies**. TypeScript, Prettier, Zod, and Valibot are development tools; the two validation libraries are used only to verify interoperability.

## One gateway file

```ts
import { createGateway } from '@ayushsoam51/llmx';
import { openai } from '@ayushsoam51/llmx/providers/openai';
import { gemini } from '@ayushsoam51/llmx/providers/gemini';

export const llm = createGateway({
  providers: {
    google: gemini({ apiKey: process.env.GEMINI_API_KEY! }),
    openai: openai({ apiKey: process.env.OPENAI_API_KEY! }),
  },
  models: {
    main_model: { provider: 'google', model: process.env.MAIN_MODEL!, fallback: ['backup_model'] },
    eval_model: { provider: 'google', model: process.env.EVAL_MODEL! },
    backup_model: { provider: 'openai', model: process.env.BACKUP_MODEL! },
  },
  limits: { concurrency: 20, rpm: 600, tpm: 1_000_000, queueSize: 1000 },
  reliability: { timeoutMs: 30_000, maxAttempts: 3 },
  logging: { payloads: 'metadata' },
});

const response = await llm.generate({
  model: 'main_model',
  messages: [{ role: 'user', content: 'Explain token reservation in one sentence.' }],
  maxOutputTokens: 200,
});
console.log(response.text, response.usage, response.attempts);
```

Aliases are opaque application-owned mappings. A new model identifier needs no package release when the provider API remains compatible. Direct calls also work:

```ts
await llm.generate({ provider: 'google', model: process.env.EVAL_MODEL!, messages });
```

## Streaming

```ts
const stream = llm.stream({ model: 'main_model', messages, signal: controller.signal });
for await (const text of stream.textStream()) process.stdout.write(text);
const final = await stream.final();
```

Alternatively iterate canonical events or call `final()` directly to drain the stream. Streams are lazy, single-consumer, and bounded by `maxResponseBytes`. Breaking iteration closes the transport. Once an event has been exposed, failures never silently retry or switch providers.

## Structured output

Use raw JSON Schema, a Standard Schema validator such as Zod or Valibot, or a custom `{ parse, jsonSchema? }` adapter.

```ts
import { z } from 'zod';

const Customer = z.object({ name: z.string() });
const response = await llm.generate({
  model: 'main_model', messages,
  output: Customer,
  jsonSchema: z.toJSONSchema(Customer),
});
response.data?.name; // inferred string
```

`output` validates the returned JSON locally. `jsonSchema` supplies the provider's native structured-output format. Standard Schema alone does not expose a JSON Schema converter. LLMX never silently rewrites prompts or repairs invalid output. The dependency-free raw validator supports a documented subset and rejects unsupported assertions before a call.

## Tools and embeddings

```ts
const response = await llm.generate({
  model: 'main_model', messages,
  tools: [{ name: 'lookup', description: 'Look up a product', parameters: {
    type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false,
  } }],
});
// Arguments are validated against registered schemas before returning the final result.
// Execute approved tools in your application; streamed fragments are not validated yet.
console.log(response.toolCalls);

const vectors = await llm.embed({ provider: 'openai', model: process.env.EMBED_MODEL!, input: ['first text', 'second text'] });
```

Anthropic embeddings fail locally with `UNSUPPORTED_FEATURE`. Gemini embeds use `batchEmbedContents`; input arrays must fit the provider's batch limits.

## Inspection and optional telemetry

```ts
logging: {
  payloads: 'full', // explicit opt-in for prompt/response inspection
  redact: ['metadata.userId', 'wire.body.customer.email'],
  sink: event => console.log(JSON.stringify(event)),
}
```

Full inspection captures the serialized outbound body just before transport. Credentials in standard authentication headers and secret query parameters are redacted. Metadata is the default; no sink or exporter is enabled implicitly. Full mode requires application-specific redaction of sensitive prompt content. See [privacy and failure semantics](docs/ARCHITECTURE.md).

```ts
import { langfuse } from '@ayushsoam51/llmx/telemetry/langfuse';
// Add to createGateway:
telemetry: { exporters: [langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  baseURL: process.env.LANGFUSE_BASE_URL,
})] }
```

Export is asynchronous, bounded, and fail-open. Call `await llm.flush()` before serverless suspension, or pass that promise to your platform's `waitUntil`. `await llm.close()` stops admission, waits for active work up to its deadline, cancels remaining work, and flushes telemetry. No Docker discovery, installation, or environment modification occurs.

## CLI

After installing the package in an application:

```sh
npx llmx init
npx llmx doctor
npx llmx config
npx llmx providers
npx llmx models
npx llmx test --model main_model
npx llmx inspect --file saved-events.json
```

`init` reports dependency and source-pattern findings, previews a minimal `llmx.config.mjs`, and asks before creating it. Existing files are never overwritten. `test` shows the configured route and token cap before requesting confirmation for a paid API call. For deliberate noninteractive execution, pass `--yes`. Other commands do not probe providers. Config files are application code and should come from a trusted source.

## Documentation

- [Architecture, behavior, defaults, and limitations](docs/ARCHITECTURE.md)
- [Requirements coverage and roadmap](docs/SCOPE.md)
- [Generated public API](docs/API.md)
- [Benchmark evidence](docs/benchmark.json)
- [Original requirements, extracted from the supplied document](docs/PRODUCT_REQUIREMENTS.md)
- [Working mock example](examples/mock.mjs)

CI is configured for Node 22 and 24 on Linux, macOS, and Windows. Local validation was performed on Node 24/Linux. Bun, Deno, edge environments, live provider credentials, and real Langfuse delivery remain unverified. Compatibility with a provider API does not imply every model supports every operation.

License selection and npm publication are intentionally pending. This repository is currently marked `UNLICENSED`.
