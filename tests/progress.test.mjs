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
  assert.equal(metrics.confidence, "medium confidence");
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
  assert.match(output, /^Project Atlas · Ship the public beta 71%/);
  assert.match(output, /#+-+/);
  assert.match(output, /ETA ~52m \(36m–1h 18m\) · medium confidence/);
  assert.match(output, /NOW Verify production path/);
  assert.doesNotMatch(output, /Required goals|DONE|SCOPE/);
});
