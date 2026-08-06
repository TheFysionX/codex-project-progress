import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../skills/track-project-progress/scripts/progress.mjs", import.meta.url));
const ledger = fileURLToPath(new URL("./fixtures/sample-ledger.json", import.meta.url));

function run(args, { noColor = true } = {}) {
  const env = { ...process.env };
  if (noColor) env.NO_COLOR = "1";
  else delete env.NO_COLOR;
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env,
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
  assert.match(result.stdout, /GOAL  Ship the public beta/);
  assert.match(result.stdout, /ETA ~52m \(36m–1h 18m\) · medium confidence/);
  assert.match(result.stdout, /-+ 71%/);
  assert.match(result.stdout, /NOW Verify production path/);
  assert.doesNotMatch(result.stdout, /Required goals:/);
});

test("CLI rejects an unknown install target", () => {
  const result = run(["install", "--target", "everything"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /target must be all/);
});

test("CLI uses emoji color when ANSI color is unavailable", () => {
  const result = run(["demo", "--theme", "compact"], { noColor: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /🟩{7}⬜{3}/u);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test("CLI rejects unsupported themes", () => {
  const result = run(["demo", "--theme", "neon"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /theme must be box, compact, or plain/);
});
