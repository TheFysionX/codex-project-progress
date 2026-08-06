#!/usr/bin/env node

import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_STATUSES = new Set(["not_started", "in_progress", "blocked", "done"]);
const VALID_UNCERTAINTY = new Set(["low", "medium", "high"]);
const VALID_TASK_TYPES = new Set(["planning", "research", "implementation", "debugging", "testing", "release", "other"]);
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_DIRECTORY = resolve(dirname(SCRIPT_PATH), "..");
const RANGE_COVERAGE = 0.9;
const RANGE_Z = 1.6448536269514722;
const PRIOR_LOG_BIAS = Math.log(1.2);
const PRIOR_SIGMA = 0.65;
const PRIOR_STRENGTH = 3;
const SIMULATION_RUNS = 6000;

function clientTargets(target, home = homedir()) {
  const openai = { client: "OpenAI (ChatGPT + Codex)", root: join(home, ".agents", "skills") };
  const claude = { client: "Claude Code", root: join(home, ".claude", "skills") };
  const legacyCodex = { client: "Codex legacy", root: join(home, ".codex", "skills") };

  if (["openai", "codex", "chatgpt"].includes(target)) return [openai];
  if (target === "claude") return [claude];
  if (target === "codex-legacy") return [legacyCodex];
  if (target === "all") return [openai, claude];
  throw new Error("--target must be all, openai, codex, chatgpt, claude, or codex-legacy");
}

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
  if (![1, 2].includes(data.schema_version)) {
    errors.push("schema_version must be 1 or 2");
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
    if (task.initial_estimate_minutes !== null && task.initial_estimate_minutes !== undefined) {
      validateNumber(task.initial_estimate_minutes, `${prefix}.initial_estimate_minutes`, errors, 0.000001);
    }
    if (task.remaining_minutes !== null && task.remaining_minutes !== undefined) {
      validateNumber(task.remaining_minutes, `${prefix}.remaining_minutes`, errors);
    }
    if (!VALID_TASK_TYPES.has(task.task_type ?? "other")) {
      errors.push(`${prefix}.task_type must be one of ${[...VALID_TASK_TYPES].sort().join(", ")}`);
    }
    for (const field of ["started_at", "completed_at", "updated_at"]) {
      if (task[field] !== null && task[field] !== undefined
        && (typeof task[field] !== "string" || Number.isNaN(Date.parse(task[field])))) {
        errors.push(`${prefix}.${field} must be an ISO-8601 timestamp`);
      }
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

  const history = data.forecast_history ?? [];
  if (!Array.isArray(history)) {
    errors.push("forecast_history must be an array");
  } else {
    history.forEach((entry, index) => {
      const prefix = `forecast_history[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (typeof entry.at !== "string" || Number.isNaN(Date.parse(entry.at))) {
        errors.push(`${prefix}.at must be an ISO-8601 timestamp`);
      }
      for (const field of ["active_elapsed_minutes", "earned_points", "total_points"]) {
        validateNumber(entry[field], `${prefix}.${field}`, errors);
      }
      for (const field of ["likely_minutes", "low_minutes", "high_minutes"]) {
        if (entry[field] !== null && entry[field] !== undefined) {
          validateNumber(entry[field], `${prefix}.${field}`, errors);
        }
      }
    });
  }

  const risks = data.risks ?? [];
  if (!Array.isArray(risks)) {
    errors.push("risks must be an array");
  } else {
    risks.forEach((risk, index) => {
      const prefix = `risks[${index}]`;
      if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (typeof risk.title !== "string" || !risk.title.trim()) {
        errors.push(`${prefix}.title must be a non-empty string`);
      }
      const probability = validateNumber(risk.probability, `${prefix}.probability`, errors);
      if (probability > 1) errors.push(`${prefix}.probability must be <= 1`);
      validateNumber(risk.impact_minutes, `${prefix}.impact_minutes`, errors);
      if (typeof (risk.active ?? true) !== "boolean") {
        errors.push(`${prefix}.active must be true or false`);
      }
    });
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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function sampleNormal(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function timingObservations(tasks) {
  const observations = [];
  tasks.forEach((task, index) => {
    const estimate = task.initial_estimate_minutes;
    const actual = task.elapsed_minutes ?? 0;
    if (!isFiniteNumber(estimate) || estimate <= 0 || actual <= 0) return;

    if (task.status === "done") {
      observations.push({
        taskType: task.task_type ?? "other",
        logRatio: Math.log(clamp(actual / estimate, 0.2, 5)),
        baseWeight: 1,
        index,
        timestamp: Date.parse(task.completed_at ?? task.updated_at ?? ""),
        completed: true,
      });
      return;
    }

    if (task.progress >= 0.1) {
      const impliedTotal = actual / task.progress;
      observations.push({
        taskType: task.task_type ?? "other",
        logRatio: Math.log(clamp(impliedTotal / estimate, 0.2, 5)),
        baseWeight: clamp(task.progress * 0.75, 0.15, 0.7),
        index,
        timestamp: Date.parse(task.updated_at ?? task.started_at ?? ""),
        completed: false,
      });
    } else if (actual > estimate) {
      const impliedTotal = actual + Math.max(task.remaining_minutes ?? 0, estimate * 0.5);
      observations.push({
        taskType: task.task_type ?? "other",
        logRatio: Math.log(clamp(impliedTotal / estimate, 0.2, 5)),
        baseWeight: 0.25,
        index,
        timestamp: Date.parse(task.updated_at ?? task.started_at ?? ""),
        completed: false,
      });
    }
  });
  observations.sort((left, right) => {
    if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp)) {
      return left.timestamp - right.timestamp;
    }
    return left.index - right.index;
  });
  return observations.map((observation, sequence) => ({ ...observation, sequence }));
}

function calibration(observations, taskType = null) {
  let weightTotal = PRIOR_STRENGTH;
  let weightedLogRatio = PRIOR_STRENGTH * PRIOR_LOG_BIAS;
  const lastSequence = observations.length ? observations.at(-1).sequence : 0;
  const weighted = observations.map((observation) => {
    const typeWeight = taskType === null
      ? 1
      : observation.taskType === taskType ? 1 : 0.35;
    const recencyWeight = 0.9 ** Math.max(0, lastSequence - observation.sequence);
    const weight = observation.baseWeight * typeWeight * recencyWeight;
    weightTotal += weight;
    weightedLogRatio += weight * observation.logRatio;
    return { ...observation, weight };
  });
  const mean = weightedLogRatio / weightTotal;
  let variance = PRIOR_STRENGTH * (PRIOR_SIGMA ** 2 + (PRIOR_LOG_BIAS - mean) ** 2);
  for (const observation of weighted) {
    variance += observation.weight * (observation.logRatio - mean) ** 2;
  }
  return {
    logBias: mean,
    biasFactor: Math.exp(mean),
    sigma: clamp(Math.sqrt(variance / weightTotal), 0.25, 1.2),
    effectiveObservations: Math.max(0, weightTotal - PRIOR_STRENGTH),
  };
}

function taskBaseRemaining(task) {
  if (isFiniteNumber(task.remaining_minutes)) return task.remaining_minutes;
  if (isFiniteNumber(task.initial_estimate_minutes)) {
    return task.initial_estimate_minutes * (1 - task.progress);
  }
  return null;
}

function uncertaintySigma(task) {
  return { low: 0.28, medium: 0.5, high: 0.82 }[task.uncertainty ?? "medium"];
}

function simulateTaskEta(data, incomplete, remainingPoints, pacePerPoint, observations) {
  const random = mulberry32(hashString(`${data.project.name}:${data.project.goal}`));
  const prepared = [];
  let coveredPoints = 0;

  for (const task of incomplete) {
    const taskRemainingPoints = task.weight * (1 - task.progress);
    let base = taskBaseRemaining(task);
    if (base === null && isFiniteNumber(pacePerPoint)) {
      base = pacePerPoint * taskRemainingPoints;
    }
    if (base === null) continue;

    coveredPoints += taskRemainingPoints;
    const taskCalibration = calibration(observations, task.task_type ?? "other");
    let median = base * taskCalibration.biasFactor;
    if (task.progress > 0 && (task.elapsed_minutes ?? 0) > 0) {
      const impliedRemaining = task.elapsed_minutes * (1 - task.progress) / task.progress;
      median = Math.max(median, impliedRemaining);
    }
    prepared.push({
      median,
      sigma: uncertaintySigma(task),
      taskCalibration,
    });
  }

  if (!prepared.length || coveredPoints <= 0) return null;
  const coverageScale = remainingPoints / coveredPoints;
  const globalCalibration = calibration(observations);
  const sharedSigma = Math.max(0.18, globalCalibration.sigma * 0.55);
  const activeRisks = (data.risks ?? []).filter((risk) => risk.active ?? true);
  const samples = [];

  for (let iteration = 0; iteration < SIMULATION_RUNS; iteration += 1) {
    let total = 0;
    for (const task of prepared) {
      total += task.median * Math.exp(task.sigma * sampleNormal(random));
    }
    total *= coverageScale * Math.exp(sharedSigma * sampleNormal(random));
    for (const risk of activeRisks) {
      if (random() < risk.probability) {
        total += risk.impact_minutes * Math.exp(0.35 * sampleNormal(random));
      }
    }
    samples.push(Math.max(0, total));
  }

  samples.sort((left, right) => left - right);
  return {
    p05: quantile(samples, 0.05),
    p50: quantile(samples, 0.5),
    p95: quantile(samples, 0.95),
    coverage: coveredPoints / remainingPoints,
  };
}

function recentPace(data, elapsedMinutes, earnedPoints, remainingPoints, fallback) {
  const history = [...(data.forecast_history ?? [])]
    .filter((entry) => entry.active_elapsed_minutes < elapsedMinutes - 0.01)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const previous = history.at(-1);
  if (!previous) return { minutes: null, stalled: false, checkpoint: null };

  const activeDelta = elapsedMinutes - previous.active_elapsed_minutes;
  const earnedDelta = earnedPoints - previous.earned_points;
  if (activeDelta <= 0) return { minutes: null, stalled: false, checkpoint: previous };
  if (earnedDelta > 0.05) {
    return {
      minutes: (activeDelta / earnedDelta) * remainingPoints,
      stalled: false,
      checkpoint: previous,
    };
  }

  const previousEta = isFiniteNumber(previous.likely_minutes) ? previous.likely_minutes : fallback;
  if (!isFiniteNumber(previousEta)) return { minutes: null, stalled: true, checkpoint: previous };
  const stallFactor = 1 + Math.min(2, activeDelta / Math.max(15, previousEta * 0.5));
  return {
    minutes: previousEta * stallFactor,
    stalled: true,
    checkpoint: previous,
  };
}

function weightedGeometricMean(candidates) {
  const usable = candidates.filter((candidate) => isFiniteNumber(candidate.minutes) && candidate.minutes > 0 && candidate.weight > 0);
  if (!usable.length) return null;
  const weightTotal = usable.reduce((sum, candidate) => sum + candidate.weight, 0);
  return Math.exp(usable.reduce((sum, candidate) => sum + candidate.weight * Math.log(candidate.minutes), 0) / weightTotal);
}

function weightedLogDisagreement(candidates, center) {
  const usable = candidates.filter((candidate) => isFiniteNumber(candidate.minutes) && candidate.minutes > 0 && candidate.weight > 0);
  if (usable.length < 2 || !isFiniteNumber(center) || center <= 0) return 0;
  const weightTotal = usable.reduce((sum, candidate) => sum + candidate.weight, 0);
  const variance = usable.reduce((sum, candidate) => (
    sum + candidate.weight * (Math.log(candidate.minutes / center) ** 2)
  ), 0) / weightTotal;
  return Math.sqrt(variance);
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
  const observations = timingObservations(tasks);
  const globalCalibration = calibration(observations);

  if (remainingPoints === 0) {
    return {
      percent,
      earnedPoints,
      totalPoints,
      elapsedMinutes,
      likelyMinutes: 0,
      lowMinutes: 0,
      highMinutes: 0,
      confidence: "high confidence",
      rangeCoverage: RANGE_COVERAGE,
      calibrationStage: "complete",
      effectiveObservations: globalCalibration.effectiveObservations,
      forecastErrorFactor: globalCalibration.biasFactor,
      estimateBasis: "complete",
      modelCandidates: [],
      recentStall: false,
      blockers,
      completedTasks,
      requiredTasks: tasks.length,
      currentTasks,
      goals: requiredGoals(data),
    };
  }

  const observed = earnedPoints > 0 && elapsedMinutes > 0
    ? (elapsedMinutes / earnedPoints) * remainingPoints
    : null;
  const pacePerPoint = earnedPoints > 0 && elapsedMinutes > 0
    ? elapsedMinutes / earnedPoints
    : null;
  const taskSimulation = simulateTaskEta(data, incomplete, remainingPoints, pacePerPoint, observations);
  const taskCandidate = taskSimulation?.p50 ?? null;
  const recent = recentPace(data, elapsedMinutes, earnedPoints, remainingPoints, taskCandidate ?? observed);
  const candidates = [
    {
      name: "calibrated task simulation",
      minutes: taskCandidate,
      weight: taskSimulation ? 0.4 + 1.4 * taskSimulation.coverage : 0,
    },
    {
      name: "whole-project throughput",
      minutes: observed,
      weight: observed === null ? 0 : clamp(earnedPoints / Math.max(1, totalPoints * 0.25), 0.25, 2),
    },
    {
      name: recent.stalled ? "recent stall correction" : "recent throughput",
      minutes: recent.minutes,
      weight: recent.minutes === null ? 0 : recent.stalled ? 2 : 1.35,
    },
  ];
  const likelyMinutes = weightedGeometricMean(candidates);
  const estimateBasis = candidates
    .filter((candidate) => candidate.weight > 0 && isFiniteNumber(candidate.minutes))
    .map((candidate) => candidate.name)
    .join(" + ") || "insufficient timing evidence";

  let lowMinutes = null;
  let highMinutes = null;
  let confidence = "insufficient timing evidence";
  if (likelyMinutes !== null) {
    let simulationSigma = 0;
    if (taskSimulation?.p05 > 0 && taskSimulation?.p95 > 0) {
      simulationSigma = Math.log(taskSimulation.p95 / taskSimulation.p05) / (2 * RANGE_Z);
    }
    const disagreementSigma = weightedLogDisagreement(candidates, likelyMinutes);
    const stageFloor = globalCalibration.effectiveObservations >= 8
      ? 0.35
      : globalCalibration.effectiveObservations >= 2 ? 0.5 : PRIOR_SIGMA;
    const rangeSigma = clamp(Math.sqrt(
      Math.max(stageFloor, simulationSigma, globalCalibration.sigma * 0.75) ** 2
      + disagreementSigma ** 2
    ), stageFloor, 1.35);
    lowMinutes = likelyMinutes * Math.exp(-RANGE_Z * rangeSigma);
    highMinutes = likelyMinutes * Math.exp(RANGE_Z * rangeSigma);
    confidence = "high confidence";
  }

  const calibrationStage = globalCalibration.effectiveObservations >= 8
    ? "calibrated"
    : globalCalibration.effectiveObservations >= 2 ? "learning" : "prior";

  return {
    percent,
    earnedPoints,
    totalPoints,
    elapsedMinutes,
    likelyMinutes,
    lowMinutes,
    highMinutes,
    confidence,
    rangeCoverage: RANGE_COVERAGE,
    calibrationStage,
    effectiveObservations: globalCalibration.effectiveObservations,
    forecastErrorFactor: globalCalibration.biasFactor,
    estimateBasis,
    modelCandidates: candidates
      .filter((candidate) => candidate.weight > 0 && isFiniteNumber(candidate.minutes))
      .map((candidate) => ({ name: candidate.name, minutes: candidate.minutes, weight: candidate.weight })),
    recentStall: recent.stalled,
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

function visibleWidth(value) {
  let width = 0;
  for (const character of stripAnsi(value)) {
    const codePoint = character.codePointAt(0);
    const isWideSymbol = codePoint >= 0x1f000 || [0x26aa, 0x2b1b, 0x2b1c].includes(codePoint);
    width += isWideSymbol ? 2 : 1;
  }
  return width;
}

function paint(value, code, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function padVisible(value, width) {
  const length = visibleWidth(value);
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

function makeEmojiBar(metrics, width = 10) {
  const filled = Math.min(width, Math.max(0, Math.round((width * metrics.percent) / 100)));
  let full = "🟩";
  if (metrics.percent >= 100) full = "🟦";
  else if (metrics.blockers.length) full = "🟥";
  return full.repeat(filled) + "⬜".repeat(width - filled);
}

function etaText(metrics) {
  if (metrics.percent >= 100) return "COMPLETE";
  if (metrics.blockers.length) {
    return `PAUSED · ~${formatDuration(metrics.likelyMinutes)} remains · blocked by ${metrics.blockers.join(", ")}`;
  }
  if (metrics.likelyMinutes === null) return "CALIBRATING · add an active-time or remaining-work estimate";
  return `~${formatDuration(metrics.likelyMinutes)} (${formatDuration(metrics.lowMinutes)}–${formatDuration(metrics.highMinutes)}) · ${metrics.confidence}`;
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
  const header = `${paint("GOAL", "1;36", color)}  ${paint(fit(data.project.goal, contentWidth - 6, ascii), "1", color)}`;
  const headerPercent = paint(`${metrics.percent.toFixed(0)}%`, `1;${percentColor(metrics.percent)}`, color);
  const progress = options.emoji ? makeEmojiBar(metrics) : makeBar(metrics.percent, Math.max(10, contentWidth - 6), ascii, color);
  const progressGap = Math.max(1, contentWidth - visibleWidth(progress) - visibleWidth(headerPercent));
  const current = metrics.currentTasks.length ? metrics.currentTasks.join(", ") : "none";
  const lines = [
    border(chars.topLeft, chars.topRight),
    line(header),
    separator,
    line(paint("ETA", "1;36", color)),
    line(paint(fit(etaText(metrics), contentWidth, ascii), "1", color)),
    line(progress + " ".repeat(progressGap) + headerPercent),
    separator,
    line(`${paint("NOW", "1", color)}  ${fit(current, contentWidth - 5, ascii)}`),
    border(chars.bottomLeft, chars.bottomRight),
  ];
  return lines.join("\n");
}

function renderCompact(data, metrics, options) {
  const barWidth = Math.max(10, options.width - 20);
  const progress = options.emoji ? makeEmojiBar(metrics) : makeBar(metrics.percent, barWidth, options.ascii, options.color);
  return [
    `${paint("GOAL", "1;36", options.color)}  ${paint(data.project.goal, "1", options.color)}`,
    `${paint("ETA", "1;36", options.color)} ${paint(etaText(metrics), "1", options.color)}`,
    `${progress} ${paint(`${metrics.percent.toFixed(0)}%`, `1;${percentColor(metrics.percent)}`, options.color)}`,
    `${paint("NOW", "1", options.color)} ${metrics.currentTasks.join(", ") || "none"}`,
  ].join("\n");
}

function renderPlain(data, metrics, options) {
  const bar = options.emoji ? makeEmojiBar(metrics) : makeBar(metrics.percent, 20, options.ascii, options.color);
  return [
    `GOAL  ${data.project.goal}`,
    `ETA   ${etaText(metrics)}`,
    `[${bar}] ${metrics.percent.toFixed(0)}%`,
    `NOW   ${metrics.currentTasks.join(", ") || "none"}`,
  ].join("\n");
}

export function renderText(data, metrics, options = {}) {
  const normalized = {
    theme: options.theme ?? "box",
    width: Math.min(100, Math.max(52, options.width ?? 72)),
    ascii: options.ascii ?? false,
    color: options.color ?? false,
    emoji: options.emoji ?? false,
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
    range_coverage: metrics.rangeCoverage,
    calibration_stage: metrics.calibrationStage,
    effective_observations: Number(metrics.effectiveObservations.toFixed(2)),
    forecast_error_factor: Number(metrics.forecastErrorFactor.toFixed(3)),
    estimate_basis: metrics.estimateBasis,
    model_candidates: metrics.modelCandidates.map((candidate) => ({
      name: candidate.name,
      minutes: Number(candidate.minutes.toFixed(2)),
      weight: Number(candidate.weight.toFixed(3)),
    })),
    recent_stall: metrics.recentStall,
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
    schema_version: 2,
    project: {
      name: "Project Atlas",
      goal: "Ship the public beta",
      done_definition: "The production acceptance path passes and release notes are published",
      scope_source: "confirmed",
    },
    tasks: [
      { id: "scope", title: "Confirm scope", milestone: "Scope", task_type: "planning", required: true, weight: 2, status: "done", progress: 1, initial_estimate_minutes: 15, elapsed_minutes: 20, remaining_minutes: 0, uncertainty: "low", blocking: false, evidence: ["Acceptance scope confirmed"] },
      { id: "build", title: "Build core workflow", milestone: "Implementation", task_type: "implementation", required: true, weight: 5, status: "done", progress: 1, initial_estimate_minutes: 60, elapsed_minutes: 70, remaining_minutes: 0, uncertainty: "low", blocking: false, evidence: ["Focused tests pass"] },
      { id: "verify", title: "Verify production path", milestone: "Verification", task_type: "testing", required: true, weight: 3, status: "in_progress", progress: 0.5, initial_estimate_minutes: 55, elapsed_minutes: 20, remaining_minutes: 35, uncertainty: "medium", blocking: false, evidence: ["Staging path verified"] },
      { id: "release", title: "Publish release", milestone: "Release", task_type: "release", required: true, weight: 2, status: "not_started", progress: 0, initial_estimate_minutes: 20, elapsed_minutes: 0, remaining_minutes: 20, uncertainty: "medium", blocking: false, evidence: [] },
    ],
    forecast_history: [
      { at: "2026-08-06T09:45:00-07:00", active_elapsed_minutes: 90, earned_points: 7, total_points: 12, likely_minutes: 62, low_minutes: 28, high_minutes: 150 },
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
    if (["ascii", "json", "markdown", "force", "help"].includes(key)) {
      options[key] = true;
    } else if (key === "no-color") {
      options.color = "never";
    } else if (["theme", "width", "color", "dest", "target"].includes(key)) {
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

async function defaultLedgerPath() {
  const current = resolve(".project-progress.json");
  const legacy = resolve(join(".codex", "project-progress.json"));
  if (await pathExists(current) || !(await pathExists(legacy))) return current;
  return legacy;
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
    const backupRoot = resolve(dirname(destinationRoot), "skill-backups");
    await mkdir(backupRoot, { recursive: true });
    backup = resolve(backupRoot, `track-project-progress-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await rename(target, backup);
  }
  await cp(SKILL_DIRECTORY, target, { recursive: true, errorOnExist: true });
  return { target, backup, alreadyInstalled: false };
}

function helpText() {
  return `codex-project-progress 0.3.0

Install and render the Track Project Progress agent skill.

Usage:
  codex-project-progress install [--target all|openai|claude] [--force]
  codex-project-progress install --dest <skills-dir> [--force]
  codex-project-progress demo [--theme box|compact|plain] [--ascii]
  codex-project-progress validate [ledger]
  codex-project-progress render [ledger] [--theme box|compact|plain]
  codex-project-progress checkpoint [ledger]

Options:
  --ascii                 Use ASCII-only borders and markers
  --color auto|always|never
  --dest <skills-dir>     Install to one custom skills directory
  --force                 Back up and replace an existing installed skill
  --json                  Return structured render output
  --markdown              Wrap the card in a fenced text block for chat
  --no-color              Alias for --color never
  --theme <name>          box (default), compact, or plain
  --target <client>       all (default), openai, codex, chatgpt, claude,
                          or codex-legacy
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
    if (options.dest && options.target) throw new Error("use either --dest or --target, not both");
    const targets = options.dest
      ? [{ client: "Custom", root: options.dest }]
      : clientTargets(options.target ?? "all");
    const existing = [];
    for (const target of targets) {
      const skillPath = resolve(target.root, "track-project-progress");
      if (skillPath !== SKILL_DIRECTORY && await pathExists(skillPath)) existing.push(skillPath);
    }
    if (existing.length && !(options.force ?? false)) {
      throw new Error(`skill already exists:\n- ${existing.join("\n- ")}\nRun again with --force to replace existing copies with recoverable backups.`);
    }
    for (const target of targets) {
      const result = await installSkill(target.root, options.force ?? false);
      if (result.alreadyInstalled) {
        process.stdout.write(`${target.client}: already installed at ${result.target}\n`);
      } else {
        process.stdout.write(`${target.client}: installed at ${result.target}\n`);
        if (result.backup) process.stdout.write(`Previous installation backed up to ${result.backup}\n`);
      }
    }
    process.stdout.write("Start a new chat or restart open clients if the skill does not appear.\n");
    return 0;
  }

  let data;
  let ledgerPath;
  if (command === "demo") {
    data = demoLedger();
  } else if (["validate", "render", "checkpoint"].includes(command)) {
    ledgerPath = options.positionals[0]
      ? resolve(options.positionals[0])
      : await defaultLedgerPath();
    data = await loadLedger(ledgerPath);
    if (command === "validate") {
      process.stdout.write(`Ledger is valid: ${ledgerPath}\n`);
      return 0;
    }
    if (command === "checkpoint") {
      const metrics = calculate(data);
      const entry = {
        at: new Date().toISOString(),
        active_elapsed_minutes: Number(metrics.elapsedMinutes.toFixed(3)),
        earned_points: Number(metrics.earnedPoints.toFixed(3)),
        total_points: Number(metrics.totalPoints.toFixed(3)),
        likely_minutes: metrics.likelyMinutes === null ? null : Number(metrics.likelyMinutes.toFixed(3)),
        low_minutes: metrics.lowMinutes === null ? null : Number(metrics.lowMinutes.toFixed(3)),
        high_minutes: metrics.highMinutes === null ? null : Number(metrics.highMinutes.toFixed(3)),
      };
      const previous = (data.forecast_history ?? []).at(-1);
      const unchanged = previous
        && previous.active_elapsed_minutes === entry.active_elapsed_minutes
        && previous.earned_points === entry.earned_points
        && previous.total_points === entry.total_points;
      if (unchanged) {
        process.stdout.write(`Checkpoint unchanged: ${ledgerPath}\n`);
        return 0;
      }
      data.schema_version = 2;
      data.forecast_history = [...(data.forecast_history ?? []), entry].slice(-50);
      data.updated_at = entry.at;
      await writeFile(ledgerPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      process.stdout.write(`Checkpoint recorded: ${ledgerPath}\n`);
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
  if (options.json && options.markdown) throw new Error("use either --json or --markdown, not both");
  if (options.json) {
    process.stdout.write(`${JSON.stringify(metricsAsJson(data, metrics, options.ascii ?? false), null, 2)}\n`);
  } else {
    const colorMode = options.color ?? "auto";
    const ansiColor = options.markdown ? false : colorEnabled(colorMode);
    const emojiColor = !(options.ascii ?? false)
      && colorMode !== "never"
      && process.env.NO_COLOR === undefined
      && !ansiColor;
    const rendered = renderText(data, metrics, {
      theme: options.theme ?? "box",
      width,
      ascii: options.ascii ?? false,
      color: ansiColor,
      emoji: emojiColor,
    });
    const output = options.markdown ? `\`\`\`text\n${rendered}\n\`\`\`` : rendered;
    process.stdout.write(`${output}\n`);
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
