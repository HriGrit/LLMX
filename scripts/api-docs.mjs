import { readFile, writeFile } from "node:fs/promises";
const modules = ["index", "types", "errors", "gateway", "scheduler", "testing"];
let markdown =
  "# Generated API reference\n\nGenerated from TypeScript declarations. Run `npm run docs` after changing public contracts. See ARCHITECTURE.md for behavior and limits.\n";
for (const module of modules) {
  const source = (await readFile(`dist/${module}.d.ts`, "utf8")).replace(
    /\/\/# sourceMappingURL=.*\n?/g,
    "",
  );
  markdown += `\n## ${module}\n\n\`\`\`ts\n${source}\`\`\`\n`;
}
await writeFile("docs/API.md", markdown);
