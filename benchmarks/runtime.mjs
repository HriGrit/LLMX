import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { createGateway } from "../dist/index.js";
import { mockProvider } from "../dist/testing.js";
const report = {
  runtime: process.version,
  platform: process.platform,
  architecture: process.arch,
  cpu: cpus()[0]?.model,
  iterations: 2000,
  network:
    "none; injected in-memory HTTP fixtures; includes fixture serialization and Response parsing",
  results: [],
};
for (const mode of ["disabled", "buffered-export"]) {
  const g = createGateway({
    providers: { p: mockProvider() },
    logging: { payloads: "none" },
    telemetry:
      mode === "buffered-export"
        ? { maxQueueSize: 100000, exporters: [{ export() {} }] }
        : undefined,
  });
  const req = {
    provider: "p",
    model: "fixture-model",
    messages: [{ role: "user", content: "hello" }],
  };
  for (let i = 0; i < 100; i++) await g.generate(req);
  const samples = [];
  for (let i = 0; i < report.iterations; i++) {
    const t = performance.now();
    await g.generate(req);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  report.results.push({
    mode,
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    p99Ms: samples[Math.floor(samples.length * 0.99)],
  });
  await g.close();
}
console.log(JSON.stringify(report, null, 2));
