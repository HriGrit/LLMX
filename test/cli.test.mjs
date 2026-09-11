import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const cli = resolve("cli/index.mjs");
test("initializer requires confirmation and never overwrites existing code", () => {
  const cwd = mkdtempSync(join(tmpdir(), "llmx-cli-"));
  try {
    writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
    const no = spawnSync(process.execPath, [cli, "init"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(no.status, 1);
    execFileSync(process.execPath, [cli, "init", "--yes"], { cwd });
    const source = readFileSync(join(cwd, "llmx.config.mjs"), "utf8");
    assert.ok(source.includes("process.env.OPENAI_API_KEY"));
    const again = spawnSync(process.execPath, [cli, "init", "--yes"], { cwd });
    assert.equal(again.status, 1);
    assert.equal(readFileSync(join(cwd, "llmx.config.mjs"), "utf8"), source);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});
