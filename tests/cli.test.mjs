import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(payload.confidence, "high confidence");
  assert.equal(payload.range_coverage, 0.9);
  assert.equal(payload.calibration_stage, "learning");
  assert.equal(payload.required_goals.length, 4);
  assert.match(payload.bar, /^\[#+-+\] 71%$/);
});

test("CLI demo renders without a ledger", () => {
  const result = run(["demo", "--theme", "compact", "--ascii", "--no-color"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GOAL  Ship the public beta/);
  assert.match(result.stdout, /ETA ~52m \(22m–2h 6m\) · high confidence/);
  assert.match(result.stdout, /-+ 71%/);
  assert.match(result.stdout, /NOW Verify production path/);
  assert.doesNotMatch(result.stdout, /Required goals:/);
});

test("CLI wraps chat output in a fenced text block", () => {
  const result = run(["demo", "--markdown"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^```text\n┌/u);
  assert.match(result.stdout, /┘\n```\n$/u);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test("CLI keeps structured JSON separate from markdown presentation", () => {
  const result = run(["demo", "--json", "--markdown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /either --json or --markdown/);
});

test("CLI records a forecast checkpoint and avoids duplicate snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-progress-checkpoint-"));
  const copy = join(directory, ".project-progress.json");
  await copyFile(ledger, copy);

  const first = run(["checkpoint", copy]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Checkpoint recorded/);
  const updated = JSON.parse(await readFile(copy, "utf8"));
  assert.equal(updated.schema_version, 2);
  assert.equal(updated.forecast_history.length, 2);
  assert.equal(updated.forecast_history.at(-1).earned_points, 8.5);

  const duplicate = run(["checkpoint", copy]);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.match(duplicate.stdout, /Checkpoint unchanged/);
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
