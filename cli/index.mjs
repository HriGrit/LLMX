#!/usr/bin/env node
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { redactor } from "../dist/telemetry.js";
const [command = "help", ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const print = (obj) => console.log(JSON.stringify(obj, null, 2));
async function confirm(question) {
  if (flag("--yes")) return true;
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive confirmation required; pass --yes to confirm explicitly",
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test(await rl.question(`${question} [y/N] `));
  } finally {
    rl.close();
  }
}
async function scan() {
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile("package.json", "utf8"));
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const files = await readdir(".");
  const findings = [];
  let inspected = 0;
  async function walk(dir, depth = 0) {
    if (depth > 4 || findings.length >= 100 || inspected >= 2000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (
        e.isSymbolicLink() ||
        e.name.startsWith(".") ||
        ["node_modules", "dist", "build", "coverage"].includes(e.name)
      )
        continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path, depth + 1);
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) {
        inspected++;
        if ((await stat(path)).size > 1000000) continue;
        const source = await readFile(path, "utf8");
        if (
          source.length < 1000000 &&
          /(?:from\s*['"](?:openai|@anthropic-ai\/sdk|@google\/genai)|chat\.completions\.create|generateContent)/.test(
            source,
          )
        )
          findings.push(path);
      }
      if (findings.length >= 100) break;
    }
  }
  await walk(".");
  return {
    runtime: process.version,
    moduleSystem: pkg.type ?? "commonjs",
    packageManager: files.includes("pnpm-lock.yaml")
      ? "pnpm"
      : files.includes("yarn.lock")
        ? "yarn"
        : files.some((x) => /^bun.lock/.test(x))
          ? "bun"
          : "npm",
    typescript: files.includes("tsconfig.json"),
    integrations: Object.keys(deps).filter((k) =>
      /openai|anthropic|google.*genai|zod|valibot|langfuse/.test(k),
    ),
    sourceFilesWithLLMCalls: findings,
  };
}
let gateway;
try {
  if (command === "help")
    console.log(
      "llmx <init|doctor|config|providers|models|test|inspect> [--config llmx.config.mjs]\ninit: [--out llmx.config.mjs] [--yes]\ntest: --model alias [--yes]\ninspect: --file saved-events.json\nNo network calls except an explicitly confirmed test.",
    );
  else if (command === "init") {
    print(await scan());
    const target = value("--out", "llmx.config.mjs");
    const source = `import { createGateway } from '@ayushsoam51/llmx';\nimport { openai } from '@ayushsoam51/llmx/providers/openai';\n\nexport default createGateway({\n  providers: { primary: openai({ apiKey: process.env.OPENAI_API_KEY }) },\n  models: { main_model: { provider: 'primary', model: process.env.LLM_MODEL } },\n  limits: { concurrency: 10, rpm: 60, tpm: 100000, queueSize: 100 },\n  logging: { payloads: 'metadata' },\n});\n`;
    console.log(`Create ${target}:\n${source}`);
    if (await confirm("Create this configuration file?")) {
      await writeFile(target, source, { flag: "wx" });
      console.log(
        `Created ${target}. Set OPENAI_API_KEY and LLM_MODEL in your environment.`,
      );
    }
  } else if (command === "inspect") {
    const file = value("--file");
    if (!file) throw new Error("--file is required");
    print(redactor([], 1048576)(JSON.parse(await readFile(file, "utf8"))));
  } else {
    if (!["doctor", "config", "providers", "models", "test"].includes(command))
      throw new Error("Unknown command; run llmx help");
    const loaded = await import(
      pathToFileURL(resolve(value("--config", "llmx.config.mjs"))).href
    );
    gateway = loaded.default ?? loaded.llm;
    if (!gateway?.inspectConfig || !gateway?.health)
      throw new Error("Config must export a gateway as default or llm");
    const config = gateway.inspectConfig();
    if (command === "config") print(config);
    if (command === "providers") print(config.providers);
    if (command === "models") print(config.models);
    if (command === "doctor")
      print({
        project: await scan(),
        health: gateway.health(),
        credentials:
          "Static credentials checked by adapter construction; callbacks checked on request",
        connectivity: "Not tested. Use the test command explicitly.",
      });
    if (command === "test") {
      const model = value("--model");
      if (!model || !Object.hasOwn(config.models, model))
        throw new Error("--model must be a configured alias");
      print({
        alias: model,
        route: config.models[model],
        maxOutputTokens: 16,
        timeoutMs: 10000,
        cost: "Unknown unless prices are configured; this call may incur charges",
      });
      if (await confirm("Send this provider request?")) {
        const r = await gateway.generate({
          model,
          maxOutputTokens: 16,
          timeoutMs: 10000,
          messages: [{ role: "user", content: "Reply with OK." }],
        });
        print({ text: r.text, usage: r.usage, cost: r.cost, timing: r.timing });
      }
    }
  }
} catch (e) {
  console.error(
    e?.code
      ? `${e.code}: ${e.message}`
      : "Command failed. Check paths, configuration, required environment variables, and arguments. Existing files are never overwritten.",
  );
  process.exitCode = 1;
} finally {
  await gateway?.close?.();
}
