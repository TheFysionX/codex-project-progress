import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../skills/track-project-progress/scripts/progress.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("installer copies the complete skill and backs up replacements", async () => {
  const destination = await mkdtemp(join(tmpdir(), "codex-progress-install-"));
  const first = run(["install", "--dest", destination]);
  assert.equal(first.status, 0, first.stderr);

  const installed = join(destination, "track-project-progress");
  const skillText = await readFile(join(installed, "SKILL.md"), "utf8");
  const scriptText = await readFile(join(installed, "scripts", "progress.mjs"), "utf8");
  assert.match(skillText, /name: track-project-progress/);
  assert.match(scriptText, /PROJECT PROGRESS/);

  const duplicate = run(["install", "--dest", destination]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /skill already exists/);

  const replacement = run(["install", "--dest", destination, "--force"]);
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.match(replacement.stdout, /Previous installation backed up/);
  const entries = await readdir(destination);
  assert.ok(entries.some((name) => name.startsWith("track-project-progress.backup-")));
});
