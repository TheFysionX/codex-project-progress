import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required for the package smoke test");
const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});

assert.equal(result.status, 0, result.stderr);
const report = JSON.parse(result.stdout)[0];
const files = new Set(report.files.map((item) => item.path));

for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "skills/track-project-progress/SKILL.md",
  "skills/track-project-progress/agents/openai.yaml",
  "skills/track-project-progress/references/ledger-format.md",
  "skills/track-project-progress/scripts/progress.mjs",
]) {
  assert.ok(files.has(required), `packed package is missing ${required}`);
}

assert.equal(report.name, "codex-project-progress");
assert.equal(report.version, "0.1.1");
assert.ok(![...files].some((path) => path.includes("__pycache__") || path.endsWith(".pyc")));
process.stdout.write(`Package smoke test passed: ${report.filename} (${report.size} bytes)\n`);
