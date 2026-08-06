#!/usr/bin/env node

import { cp, mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_STATUSES = new Set(["not_started", "in_progress", "blocked", "done"]);
const VALID_UNCERTAINTY = new Set(["low", "medium", "high"]);
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_DIRECTORY = resolve(dirname(SCRIPT_PATH), "..");

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateNumber(value, field, errors, minimum = 0) {
  if (!isFiniteNumber(value)) {
    errors.push(`${field} must be a number`);
    return 0;
  }
  if (value < minimum) {
    errors.push(`${field} must be >= ${minimum}`);
    return 0;
  }
  return value;
}

export function validateLedger(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["ledger root must be a JSON object"];
  }
  if (data.schema_version !== 1) {
    errors.push("schema_version must be 1");
  }

  const project = data.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    errors.push("project must be an object");
  } else {
    for (const field of ["name", "goal", "done_definition"]) {
      if (typeof project[field] !== "string" || !project[field].trim()) {
        errors.push(`project.${field} must be a non-empty string`);
      }
    }
    if (!["inferred", "confirmed"].includes(project.scope_source ?? "inferred")) {
      errors.push("project.scope_source must be inferred or confirmed");
    }
  }

  if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
    errors.push("tasks must be a non-empty array");
    return errors;
  }

  const seenIds = new Set();
  let requiredCount = 0;
  data.tasks.forEach((task, index) => {
    const prefix = `tasks[${index}]`;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    if (typeof task.id !== "string" || !task.id.trim()) {
      errors.push(`${prefix}.id must be a non-empty string`);
    } else if (seenIds.has(task.id)) {
      errors.push(`${prefix}.id duplicates ${JSON.stringify(task.id)}`);
    } else {
      seenIds.add(task.id);
    }

    if (typeof task.title !== "string" || !task.title.trim()) {
      errors.push(`${prefix}.title must be a non-empty string`);
    }

    const required = task.required ?? true;
    if (typeof required !== "boolean") {
      errors.push(`${prefix}.required must be true or false`);
    } else if (required) {
      requiredCount += 1;
    }

    validateNumber(task.weight, `${prefix}.weight`, errors, 0.000001);
    const progress = validateNumber(task.progress, `${prefix}.progress`, errors);
    if (progress > 1) {
      errors.push(`${prefix}.progress must be <= 1`);
    }

    if (!VALID_STATUSES.has(task.status)) {
      errors.push(`${prefix}.status must be one of ${[...VALID_STATUSES].sort().join(", ")}`);
    } else if (task.status === "done" && progress !== 1) {
      errors.push(`${prefix}.progress must be 1 when status is done`);
    } else if (task.status === "not_started" && progress !== 0) {
      errors.push(`${prefix}.progress must be 0 when status is not_started`);
    }

    validateNumber(task.elapsed_minutes ?? 0, `${prefix}.elapsed_minutes`, errors);
    if (task.remaining_minutes !== null && task.remaining_minutes !== undefined) {
      validateNumber(task.remaining_minutes, `${prefix}.remaining_minutes`, errors);
    }
    if (!VALID_UNCERTAINTY.has(task.uncertainty ?? "medium")) {
      errors.push(`${prefix}.uncertainty must be one of ${[...VALID_UNCERTAINTY].sort().join(", ")}`);
    }
    if (typeof (task.blocking ?? false) !== "boolean") {
      errors.push(`${prefix}.blocking must be true or false`);
    }

    const evidence = task.evidence ?? [];
    if (!Array.isArray(evidence) || !evidence.every((item) => typeof item === "string")) {
      errors.push(`${prefix}.evidence must be an array of strings`);
    } else if (task.status === "done" && !evidence.some((item) => item.trim())) {
      errors.push(`${prefix}.evidence needs at least one item when status is done`);
    }
  });

  if (requiredCount === 0) {
    errors.push("at least one task must be required");
  }
  return errors;
}

export function requiredGoals(data) {
  const grouped = new Map();
  for (const task of data.tasks) {
    if (!(task.required ?? true)) continue;
    const name = task.milestone || task.title;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(task);
  }

  return [...grouped.entries()].map(([name, tasks]) => {
    const total = tasks.reduce((sum, task) => sum + task.weight, 0);
    const earned = tasks.reduce((sum, task) => sum + task.weight * task.progress, 0);
    return {
      name,
      percent: (100 * earned) / total,
      blocked: tasks.some((task) => (task.blocking ?? false) && task.progress < 1),
    };
  });
}

export function calculate(data) {
  const tasks = data.tasks.filter((task) => task.required ?? true);
  const totalPoints = tasks.reduce((sum, task) => sum + task.weight, 0);
  const earnedPoints = tasks.reduce((sum, task) => sum + task.weight * task.progress, 0);
  const remainingPoints = Math.max(0, totalPoints - earnedPoints);
  const percent = (100 * earnedPoints) / totalPoints;
  const elapsedMinutes = tasks.reduce((sum, task) => sum + (task.elapsed_minutes ?? 0), 0);
  const completedTasks = tasks.filter((task) => task.status === "done").length;
  const incomplete = tasks.filter((task) => task.progress < 1);
  const blockers = incomplete.filter((task) => task.blocking ?? false).map((task) => task.title);
  const currentTasks = incomplete
    .filter((task) => ["in_progress", "blocked"].includes(task.status))
    .map((task) => task.title);

  let coveredPoints = 0;
  let knownRemaining = 0;
  let highUncertaintyPoints = 0;
  for (const task of incomplete) {
    const taskRemainingPoints = task.weight * (1 - task.progress);
    if (task.remaining_minutes !== null && task.remaining_minutes !== undefined) {
      coveredPoints += taskRemainingPoints;
      knownRemaining += task.remaining_minutes;
    }
    if ((task.uncertainty ?? "medium") === "high") {
      highUncertaintyPoints += taskRemainingPoints;
    }
  }

  const coverage = remainingPoints ? coveredPoints / remainingPoints : 1;
  const bottomUp = coveredPoints > 0 ? (knownRemaining * remainingPoints) / coveredPoints : null;
  const observed = earnedPoints > 0 && elapsedMinutes > 0
    ? (elapsedMinutes / earnedPoints) * remainingPoints
    : null;

  let likelyMinutes;
  let lowMinutes;
  let highMinutes;
  let confidence;
  let estimateBasis;

  if (remainingPoints === 0) {
    likelyMinutes = lowMinutes = highMinutes = 0;
    confidence = "high confidence";
    estimateBasis = "complete";
  } else {
    if (bottomUp !== null && observed !== null) {
      const observedWeight = Math.min(0.75, Math.max(0.2, completedTasks / 6));
      likelyMinutes = observedWeight * observed + (1 - observedWeight) * bottomUp;
      estimateBasis = "bottom-up estimates + observed throughput";
    } else if (bottomUp !== null) {
      likelyMinutes = bottomUp;
      estimateBasis = "bottom-up estimates";
    } else if (observed !== null) {
      likelyMinutes = observed;
      estimateBasis = "observed throughput";
    } else {
      likelyMinutes = null;
      estimateBasis = "insufficient timing evidence";
    }

    const highUncertaintyShare = remainingPoints ? highUncertaintyPoints / remainingPoints : 0;
    if (likelyMinutes === null) {
      confidence = "low confidence";
    } else if (completedTasks >= 5 && percent >= 50 && coverage >= 0.8 && highUncertaintyShare < 0.2) {
      confidence = "high confidence";
    } else if ((completedTasks >= 2 || percent >= 20) && coverage >= 0.4 && highUncertaintyShare < 0.6) {
      confidence = "medium confidence";
    } else {
      confidence = "low confidence";
    }

    const factors = {
      "high confidence": [0.85, 1.25],
      "medium confidence": [0.7, 1.5],
      "low confidence": [0.5, 2],
    };
    if (likelyMinutes === null) {
      lowMinutes = highMinutes = null;
    } else {
      const [lowFactor, highFactor] = factors[confidence];
      lowMinutes = likelyMinutes * lowFactor;
      highMinutes = likelyMinutes * highFactor;
    }
  }

  return {
    percent,
    earnedPoints,
    totalPoints,
    elapsedMinutes,
    likelyMinutes,
    lowMinutes,
    highMinutes,
    confidence,
    estimateBasis,
    blockers,
    completedTasks,
    requiredTasks: tasks.length,
    currentTasks,
    goals: requiredGoals(data),
  };
}

export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return "unknown";
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded === 0) return "0m";
  const days = Math.floor(rounded / (60 * 8));
  const remainder = rounded % (60 * 8);
  const hours = Math.floor(remainder / 60);
  const mins = remainder % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins && parts.length < 2) parts.push(`${mins}m`);
  return parts.join(" ");
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}

function paint(value, code, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function padVisible(value, width) {
  const length = stripAnsi(value).length;
  return value + " ".repeat(Math.max(0, width - length));
}

function fit(value, width, asciiOnly = false) {
  const clean = String(value).replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean;
  const suffix = asciiOnly ? "..." : "…";
  return clean.slice(0, Math.max(0, width - suffix.length)) + suffix;
}

function percentColor(percent) {
  if (percent >= 70) return 32;
  if (percent >= 35) return 33;
  return 35;
}

export function makeBar(percent, width, asciiOnly = false, color = false) {
  const filled = Math.min(width, Math.max(0, Math.round((width * percent) / 100)));
  const full = asciiOnly ? "#" : "█";
  const empty = asciiOnly ? "-" : "░";
  return paint(full.repeat(filled), percentColor(percent), color) + empty.repeat(width - filled);
}

function etaText(metrics) {
  return `${etaHeadline(metrics)} · ${etaDetail(metrics)}`;
}

function etaHeadline(metrics) {
  if (metrics.percent >= 100) return "COMPLETE";
  if (metrics.blockers.length) return "PAUSED";
  if (metrics.likelyMinutes === null) return "UNKNOWN";
  return `~${formatDuration(metrics.likelyMinutes)} ACTIVE WORK`;
}

function etaDetail(metrics) {
  if (metrics.percent >= 100) return "All required work is verified";
  if (metrics.blockers.length) {
    return `Blocked by ${metrics.blockers.join(", ")} · ${formatDuration(metrics.likelyMinutes)} active work remains`;
  }
  if (metrics.likelyMinutes === null) return "Not enough timing evidence · low confidence";
  return `Likely range ${formatDuration(metrics.lowMinutes)}–${formatDuration(metrics.highMinutes)} · ${metrics.confidence}`;
}

function renderBox(data, metrics, options) {
  const width = options.width;
  const ascii = options.ascii;
  const color = options.color;
  const contentWidth = width - 4;
  const chars = ascii
    ? { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", left: "+", right: "+" }
    : { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", left: "├", right: "┤" };
  const border = (left, right) => left + chars.horizontal.repeat(width - 2) + right;
  const line = (value = "") => `${chars.vertical} ${padVisible(value, contentWidth)} ${chars.vertical}`;
  const separator = border(chars.left, chars.right);
  const headerPercent = paint(`${metrics.percent.toFixed(0)}%`, `1;${percentColor(metrics.percent)}`, color);
  const titleWidth = contentWidth - stripAnsi(headerPercent).length - 1;
  const title = paint(fit(`${data.project.name} · ${data.project.goal}`, titleWidth, ascii), "1;36", color);
  const headerGap = Math.max(1, contentWidth - stripAnsi(title).length - stripAnsi(headerPercent).length);
  const current = metrics.currentTasks.length ? metrics.currentTasks.join(", ") : "none";
  const lines = [
    border(chars.topLeft, chars.topRight),
    line(title + " ".repeat(headerGap) + headerPercent),
    line(makeBar(metrics.percent, contentWidth, ascii, color)),
    separator,
    line(paint("ETA", "1;36", color)),
    line(paint(fit(etaHeadline(metrics), contentWidth, ascii), "1", color)),
    line(fit(etaDetail(metrics), contentWidth, ascii)),
    separator,
    line(`${paint("NOW", "1", color)}  ${fit(current, contentWidth - 5, ascii)}`),
    border(chars.bottomLeft, chars.bottomRight),
  ];
  return lines.join("\n");
}

function renderCompact(data, metrics, options) {
  const barWidth = Math.max(10, options.width - 20);
  const title = `${data.project.name} · ${data.project.goal}`;
  return [
    `${paint(title, "1;36", options.color)} ${paint(`${metrics.percent.toFixed(0)}%`, `1;${percentColor(metrics.percent)}`, options.color)}`,
    makeBar(metrics.percent, barWidth, options.ascii, options.color),
    `${paint("ETA", "1;36", options.color)} ${paint(etaHeadline(metrics), "1", options.color)}`,
    `    ${etaDetail(metrics)}`,
    `${paint("NOW", "1", options.color)} ${metrics.currentTasks.join(", ") || "none"}`,
  ].join("\n");
}

function renderPlain(data, metrics, options) {
  const bar = makeBar(metrics.percent, 20, options.ascii, options.color);
  return [
    `${data.project.name} · ${data.project.goal} ${metrics.percent.toFixed(0)}%`,
    `[${bar}]`,
    `ETA: ${etaText(metrics)}`,
    `NOW: ${metrics.currentTasks.join(", ") || "none"}`,
  ].join("\n");
}

export function renderText(data, metrics, options = {}) {
  const normalized = {
    theme: options.theme ?? "box",
    width: Math.min(100, Math.max(52, options.width ?? 72)),
    ascii: options.ascii ?? false,
    color: options.color ?? false,
  };
  if (normalized.theme === "compact") return renderCompact(data, metrics, normalized);
  if (normalized.theme === "plain") return renderPlain(data, metrics, normalized);
  if (normalized.theme !== "box") throw new Error("--theme must be box, compact, or plain");
  return renderBox(data, metrics, normalized);
}

export function metricsAsJson(data, metrics, ascii = false) {
  return {
    project: data.project,
    percent: Number(metrics.percent.toFixed(2)),
    earned_points: Number(metrics.earnedPoints.toFixed(3)),
    total_points: Number(metrics.totalPoints.toFixed(3)),
    completed_tasks: metrics.completedTasks,
    required_tasks: metrics.requiredTasks,
    elapsed_minutes: Number(metrics.elapsedMinutes.toFixed(2)),
    likely_minutes: metrics.likelyMinutes === null ? null : Number(metrics.likelyMinutes.toFixed(2)),
    range_minutes: [
      metrics.lowMinutes === null ? null : Number(metrics.lowMinutes.toFixed(2)),
      metrics.highMinutes === null ? null : Number(metrics.highMinutes.toFixed(2)),
    ],
    confidence: metrics.confidence,
    estimate_basis: metrics.estimateBasis,
    current_tasks: metrics.currentTasks,
    blockers: metrics.blockers,
    required_goals: metrics.goals,
    bar: `[${makeBar(metrics.percent, 20, ascii, false)}] ${metrics.percent.toFixed(0)}%`,
  };
}

export async function loadLedger(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`ledger not found: ${path}`);
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`);
  }
  const errors = validateLedger(data);
  if (errors.length) throw new Error(`invalid ledger:\n- ${errors.join("\n- ")}`);
  return data;
}

function demoLedger() {
  return {
    schema_version: 1,
    project: {
      name: "Project Atlas",
      goal: "Ship the public beta",
      done_definition: "The production acceptance path passes and release notes are published",
      scope_source: "confirmed",
    },
    tasks: [
      { id: "scope", title: "Confirm scope", milestone: "Scope", required: true, weight: 2, status: "done", progress: 1, elapsed_minutes: 20, remaining_minutes: 0, uncertainty: "low", blocking: false, evidence: ["Acceptance scope confirmed"] },
      { id: "build", title: "Build core workflow", milestone: "Implementation", required: true, weight: 5, status: "done", progress: 1, elapsed_minutes: 70, remaining_minutes: 0, uncertainty: "low", blocking: false, evidence: ["Focused tests pass"] },
      { id: "verify", title: "Verify production path", milestone: "Verification", required: true, weight: 3, status: "in_progress", progress: 0.5, elapsed_minutes: 20, remaining_minutes: 35, uncertainty: "medium", blocking: false, evidence: ["Staging path verified"] },
      { id: "release", title: "Publish release", milestone: "Release", required: true, weight: 2, status: "not_started", progress: 0, elapsed_minutes: 0, remaining_minutes: 20, uncertainty: "medium", blocking: false, evidence: [] },
    ],
  };
}

function parseArgs(argv) {
  const options = { positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      options.positionals.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split("=", 2);
    if (["ascii", "json", "force", "help"].includes(key)) {
      options[key] = true;
    } else if (key === "no-color") {
      options.color = "never";
    } else if (["theme", "width", "color", "dest"].includes(key)) {
      const next = inline ?? argv[++index];
      if (next === undefined) throw new Error(`--${key} requires a value`);
      options[key] = next;
    } else {
      throw new Error(`unknown option: --${key}`);
    }
  }
  return options;
}

function colorEnabled(mode) {
  if (mode === "always") return true;
  if (mode === "never" || process.env.NO_COLOR !== undefined) return false;
  if (mode && mode !== "auto") throw new Error("--color must be auto, always, or never");
  return Boolean(process.stdout.isTTY);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function installSkill(destinationRoot, force) {
  const target = resolve(destinationRoot, "track-project-progress");
  if (target === SKILL_DIRECTORY) {
    return { target, backup: null, alreadyInstalled: true };
  }
  await mkdir(resolve(destinationRoot), { recursive: true });
  let backup = null;
  if (await pathExists(target)) {
    if (!force) throw new Error(`skill already exists: ${target}\nRun again with --force to replace it with a recoverable backup.`);
    backup = `${target}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(target, backup);
  }
  await cp(SKILL_DIRECTORY, target, { recursive: true, errorOnExist: true });
  return { target, backup, alreadyInstalled: false };
}

function helpText() {
  return `codex-project-progress 0.1.1

Install and render the Track Project Progress Codex skill.

Usage:
  codex-project-progress install [--dest <skills-dir>] [--force]
  codex-project-progress demo [--theme box|compact|plain] [--ascii]
  codex-project-progress validate [ledger]
  codex-project-progress render [ledger] [--theme box|compact|plain]

Options:
  --ascii                 Use ASCII-only borders and markers
  --color auto|always|never
  --dest <skills-dir>     Default: ~/.agents/skills
  --force                 Back up and replace an existing installed skill
  --json                  Return structured render output
  --no-color              Alias for --color never
  --theme <name>          box (default), compact, or plain
  --width <52-100>        Width of the boxed renderer
`;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  const options = parseArgs(argv.slice(1));
  if (["help", "--help", "-h"].includes(command) || options.help) {
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "install") {
    const root = options.dest ?? join(homedir(), ".agents", "skills");
    const result = await installSkill(root, options.force ?? false);
    if (result.alreadyInstalled) {
      process.stdout.write(`Skill is already installed at ${result.target}\n`);
    } else {
      process.stdout.write(`Installed track-project-progress to ${result.target}\n`);
      if (result.backup) process.stdout.write(`Previous installation backed up to ${result.backup}\n`);
      process.stdout.write("Codex will detect the skill automatically; restart it if the skill does not appear.\n");
    }
    return 0;
  }

  let data;
  if (command === "demo") {
    data = demoLedger();
  } else if (["validate", "render"].includes(command)) {
    const ledgerPath = resolve(options.positionals[0] ?? join(".codex", "project-progress.json"));
    data = await loadLedger(ledgerPath);
    if (command === "validate") {
      process.stdout.write(`Ledger is valid: ${ledgerPath}\n`);
      return 0;
    }
  } else {
    throw new Error(`unknown command: ${command}\n\n${helpText()}`);
  }

  const width = options.width === undefined ? 72 : Number(options.width);
  if (!Number.isInteger(width) || width < 52 || width > 100) {
    throw new Error("--width must be an integer between 52 and 100");
  }
  const metrics = calculate(data);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(metricsAsJson(data, metrics, options.ascii ?? false), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(data, metrics, {
      theme: options.theme ?? "box",
      width,
      ascii: options.ascii ?? false,
      color: colorEnabled(options.color ?? "auto"),
    })}\n`);
  }
  return 0;
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH);
if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  });
}
