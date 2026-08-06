import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../skills/track-project-progress/scripts/progress.mjs", import.meta.url));
const ledger = fileURLToPath(new URL("./fixtures/sample-ledger.json", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("CLI validates a ledger", () => {
  const result = run(["validate", ledger]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ledger is valid/);
});

test("CLI emits structured JSON", () => {
  const result = run(["render", ledger, "--json", "--ascii"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.percent, 70.83);
  assert.equal(payload.required_goals.length, 4);
  assert.match(payload.bar, /^\[#+-+\] 71%$/);
});

test("CLI demo renders without a ledger", () => {
  const result = run(["demo", "--theme", "compact", "--ascii", "--no-color"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PROJECT PROGRESS 71%/);
  assert.match(result.stdout, /Required goals:/);
});

test("CLI rejects unsupported themes", () => {
  const result = run(["demo", "--theme", "neon"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /theme must be box, compact, or plain/);
});
