import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculate,
  renderText,
  validateLedger,
} from "../skills/track-project-progress/scripts/progress.mjs";

const fixtureUrl = new URL("./fixtures/sample-ledger.json", import.meta.url);
const snapshotUrl = new URL("./snapshots/demo-box.txt", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("calculates weighted progress and excludes optional scope", async () => {
  const data = await fixture();
  assert.deepEqual(validateLedger(data), []);
  const metrics = calculate(data);
  assert.equal(metrics.totalPoints, 12);
  assert.equal(metrics.earnedPoints, 8.5);
  assert.equal(Number(metrics.percent.toFixed(2)), 70.83);
  assert.equal(metrics.goals.length, 4);
  assert.ok(metrics.likelyMinutes > 0);
  assert.equal(metrics.confidence, "high confidence");
  assert.equal(metrics.rangeCoverage, 0.9);
  assert.equal(metrics.calibrationStage, "learning");
  assert.ok(metrics.lowMinutes < metrics.likelyMinutes);
  assert.ok(metrics.highMinutes > metrics.likelyMinutes);
});

test("requires evidence before a task can be done", async () => {
  const data = await fixture();
  data.tasks[0].evidence = [];
  assert.ok(validateLedger(data).some((message) => message.includes("evidence needs at least one item")));
});

test("pauses ETA when required work is blocked", async () => {
  const data = await fixture();
  data.tasks[2].status = "blocked";
  data.tasks[2].blocking = true;
  const metrics = calculate(data);
  const output = renderText(data, metrics, { color: false });
  assert.match(output, /PAUSED/);
  assert.match(output, /blocked by Verify production path/);
});

test("reports complete only when all required tasks are done", async () => {
  const data = await fixture();
  for (const task of data.tasks.filter((item) => item.required)) {
    task.status = "done";
    task.progress = 1;
    task.remaining_minutes = 0;
    task.evidence = ["Verified"];
  }
  const metrics = calculate(data);
  assert.equal(metrics.percent, 100);
  assert.equal(metrics.likelyMinutes, 0);
  assert.match(renderText(data, metrics, { color: false }), /ETA[\s\S]+COMPLETE/);
});

test("boxed visualization matches its reviewed snapshot", async () => {
  const data = await fixture();
  const output = renderText(data, calculate(data), { theme: "box", width: 72, color: false, emoji: true });
  const expected = (await readFile(snapshotUrl, "utf8")).trimEnd();
  assert.equal(output, expected);
});

test("ETA appears before the percentage bar and NOW", async () => {
  const data = await fixture();
  const output = renderText(data, calculate(data), { theme: "box", color: false, emoji: true });
  assert.ok(output.indexOf("GOAL") < output.indexOf("ETA"));
  assert.ok(output.indexOf("ETA") < output.indexOf("71%"));
  assert.ok(output.indexOf("71%") < output.indexOf("NOW"));
  assert.doesNotMatch(output, /Project Atlas|ACTIVE WORK|LIKELY RANGE/i);
});

test("completed-task forecast errors adapt the ETA in the expected direction", async () => {
  const data = await fixture();
  const underestimated = structuredClone(data);
  underestimated.tasks[0].initial_estimate_minutes = 8;
  underestimated.tasks[1].initial_estimate_minutes = 25;

  const overestimated = structuredClone(data);
  overestimated.tasks[0].initial_estimate_minutes = 30;
  overestimated.tasks[1].initial_estimate_minutes = 120;

  const slow = calculate(underestimated);
  const fast = calculate(overestimated);
  assert.ok(slow.forecastErrorFactor > 1);
  assert.ok(fast.forecastErrorFactor < 1);
  assert.ok(slow.likelyMinutes > fast.likelyMinutes);
  assert.ok(slow.highMinutes > fast.highMinutes);
});

test("consistent comparable history advances calibration and narrows the range", async () => {
  const data = await fixture();
  data.forecast_history = [];
  const sparse = calculate(data);

  for (let index = 0; index < 30; index += 1) {
    data.tasks.push({
      id: `history-${index}`,
      title: `Historic verification ${index}`,
      milestone: "History",
      task_type: "testing",
      required: true,
      weight: 1,
      status: "done",
      progress: 1,
      initial_estimate_minutes: 10,
      elapsed_minutes: 10,
      remaining_minutes: 0,
      uncertainty: "low",
      blocking: false,
      evidence: ["Verified in history"],
    });
  }

  const mature = calculate(data);
  assert.equal(mature.calibrationStage, "calibrated");
  assert.ok(mature.effectiveObservations >= 8);
  assert.ok((mature.highMinutes / mature.lowMinutes) < (sparse.highMinutes / sparse.lowMinutes));
});

test("recent active time with no earned progress increases ETA and flags a stall", async () => {
  const data = await fixture();
  const withoutHistory = structuredClone(data);
  withoutHistory.forecast_history = [];
  const baseline = calculate(withoutHistory);

  data.forecast_history = [{
    at: "2026-08-06T09:00:00Z",
    active_elapsed_minutes: 80,
    earned_points: 8.5,
    total_points: 12,
    likely_minutes: 40,
    low_minutes: 20,
    high_minutes: 90,
  }];
  const stalled = calculate(data);
  assert.equal(stalled.recentStall, true);
  assert.match(stalled.estimateBasis, /stall correction/);
  assert.ok(stalled.likelyMinutes > baseline.likelyMinutes);
  assert.ok(stalled.highMinutes > baseline.highMinutes);
});

test("schema version 1 remains backward compatible", async () => {
  const data = await fixture();
  data.schema_version = 1;
  delete data.forecast_history;
  for (const task of data.tasks) {
    delete task.task_type;
    delete task.initial_estimate_minutes;
  }
  assert.deepEqual(validateLedger(data), []);
  const metrics = calculate(data);
  assert.equal(metrics.confidence, "high confidence");
  assert.ok(metrics.likelyMinutes > 0);
});

test("emoji bars communicate healthy, blocked, and complete states", async () => {
  const data = await fixture();
  assert.match(renderText(data, calculate(data), { theme: "compact", emoji: true }), /🟩{7}⬜{3}/u);

  data.tasks[2].status = "blocked";
  data.tasks[2].blocking = true;
  assert.match(renderText(data, calculate(data), { theme: "compact", emoji: true }), /🟥{7}⬜{3}/u);

  for (const task of data.tasks.filter((item) => item.required)) {
    task.status = "done";
    task.progress = 1;
    task.remaining_minutes = 0;
    task.blocking = false;
    task.evidence = ["Verified"];
  }
  assert.match(renderText(data, calculate(data), { theme: "compact", emoji: true }), /🟦{10}/u);
});

test("compact ASCII visualization remains readable", async () => {
  const data = await fixture();
  const output = renderText(data, calculate(data), {
    theme: "compact",
    width: 64,
    ascii: true,
    color: false,
  });
  assert.match(output, /^GOAL  Ship the public beta/);
  assert.match(output, /#+-+/);
  assert.match(output, /ETA ~52m \(22m–2h 6m\) · high confidence/);
  assert.match(output, /-+ 71%/);
  assert.match(output, /NOW Verify production path/);
  assert.doesNotMatch(output, /Required goals|DONE|SCOPE/);
});
