#!/usr/bin/env python3
"""Validate and render an evidence-weighted Codex project progress ledger."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


VALID_STATUSES = {"not_started", "in_progress", "blocked", "done"}
VALID_UNCERTAINTY = {"low", "medium", "high"}


@dataclass(frozen=True)
class Metrics:
    percent: float
    earned_points: float
    total_points: float
    elapsed_minutes: float
    likely_minutes: float | None
    low_minutes: float | None
    high_minutes: float | None
    confidence: str
    estimate_basis: str
    blockers: tuple[str, ...]
    completed_tasks: int
    required_tasks: int
    current_tasks: tuple[str, ...]


def _number(value: Any, field: str, errors: list[str], *, minimum: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        errors.append(f"{field} must be a number")
        return 0.0
    number = float(value)
    if not math.isfinite(number) or number < minimum:
        errors.append(f"{field} must be finite and >= {minimum}")
        return 0.0
    return number


def validate_ledger(data: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["ledger root must be a JSON object"]

    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")

    project = data.get("project")
    if not isinstance(project, dict):
        errors.append("project must be an object")
    else:
        for field in ("name", "goal", "done_definition"):
            if not isinstance(project.get(field), str) or not project[field].strip():
                errors.append(f"project.{field} must be a non-empty string")
        if project.get("scope_source", "inferred") not in {"inferred", "confirmed"}:
            errors.append("project.scope_source must be inferred or confirmed")

    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        errors.append("tasks must be a non-empty array")
        return errors

    seen_ids: set[str] = set()
    required_count = 0
    for index, task in enumerate(tasks):
        prefix = f"tasks[{index}]"
        if not isinstance(task, dict):
            errors.append(f"{prefix} must be an object")
            continue

        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
        elif task_id in seen_ids:
            errors.append(f"{prefix}.id duplicates {task_id!r}")
        else:
            seen_ids.add(task_id)

        if not isinstance(task.get("title"), str) or not task["title"].strip():
            errors.append(f"{prefix}.title must be a non-empty string")

        required = task.get("required", True)
        if not isinstance(required, bool):
            errors.append(f"{prefix}.required must be true or false")
        elif required:
            required_count += 1

        _number(task.get("weight"), f"{prefix}.weight", errors, minimum=0.000001)
        progress = _number(task.get("progress"), f"{prefix}.progress", errors)
        if progress > 1:
            errors.append(f"{prefix}.progress must be <= 1")

        status = task.get("status")
        if status not in VALID_STATUSES:
            errors.append(f"{prefix}.status must be one of {sorted(VALID_STATUSES)}")
        elif status == "done" and progress != 1:
            errors.append(f"{prefix}.progress must be 1 when status is done")
        elif status == "not_started" and progress != 0:
            errors.append(f"{prefix}.progress must be 0 when status is not_started")

        _number(task.get("elapsed_minutes", 0), f"{prefix}.elapsed_minutes", errors)
        remaining = task.get("remaining_minutes")
        if remaining is not None:
            _number(remaining, f"{prefix}.remaining_minutes", errors)

        if task.get("uncertainty", "medium") not in VALID_UNCERTAINTY:
            errors.append(f"{prefix}.uncertainty must be one of {sorted(VALID_UNCERTAINTY)}")
        if not isinstance(task.get("blocking", False), bool):
            errors.append(f"{prefix}.blocking must be true or false")

        evidence = task.get("evidence", [])
        if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
            errors.append(f"{prefix}.evidence must be an array of strings")
        elif status == "done" and not any(item.strip() for item in evidence):
            errors.append(f"{prefix}.evidence needs at least one item when status is done")

    if required_count == 0:
        errors.append("at least one task must be required")
    return errors


def calculate(data: dict[str, Any]) -> Metrics:
    tasks = [task for task in data["tasks"] if task.get("required", True)]
    total_points = sum(float(task["weight"]) for task in tasks)
    earned_points = sum(float(task["weight"]) * float(task["progress"]) for task in tasks)
    remaining_points = max(0.0, total_points - earned_points)
    percent = 100.0 * earned_points / total_points
    elapsed = sum(float(task.get("elapsed_minutes", 0)) for task in tasks)
    completed = sum(task["status"] == "done" for task in tasks)

    incomplete = [task for task in tasks if float(task["progress"]) < 1]
    blockers = tuple(task["title"] for task in incomplete if task.get("blocking", False))
    current = tuple(task["title"] for task in incomplete if task["status"] in {"in_progress", "blocked"})

    covered_points = 0.0
    known_remaining = 0.0
    high_uncertainty_points = 0.0
    for task in incomplete:
        task_remaining_points = float(task["weight"]) * (1 - float(task["progress"]))
        if task.get("remaining_minutes") is not None:
            covered_points += task_remaining_points
            known_remaining += float(task["remaining_minutes"])
        if task.get("uncertainty", "medium") == "high":
            high_uncertainty_points += task_remaining_points

    coverage = covered_points / remaining_points if remaining_points else 1.0
    bottom_up = None
    if covered_points > 0:
        bottom_up = known_remaining * remaining_points / covered_points

    observed = None
    if earned_points > 0 and elapsed > 0:
        observed = elapsed / earned_points * remaining_points

    if remaining_points == 0:
        likely = low = high = 0.0
        confidence = "high confidence"
        basis = "complete"
    else:
        if bottom_up is not None and observed is not None:
            observed_weight = min(0.75, max(0.20, completed / 6))
            likely = observed_weight * observed + (1 - observed_weight) * bottom_up
            basis = "bottom-up estimates + observed throughput"
        elif bottom_up is not None:
            likely = bottom_up
            basis = "bottom-up estimates"
        elif observed is not None:
            likely = observed
            basis = "observed throughput"
        else:
            likely = None
            basis = "insufficient timing evidence"

        high_uncertainty_share = high_uncertainty_points / remaining_points if remaining_points else 0
        if likely is None:
            confidence = "low confidence"
        elif completed >= 5 and percent >= 50 and coverage >= 0.8 and high_uncertainty_share < 0.2:
            confidence = "high confidence"
        elif (completed >= 2 or percent >= 20) and coverage >= 0.4 and high_uncertainty_share < 0.6:
            confidence = "medium confidence"
        else:
            confidence = "low confidence"

        factors = {
            "high confidence": (0.85, 1.25),
            "medium confidence": (0.70, 1.50),
            "low confidence": (0.50, 2.00),
        }
        if likely is None:
            low = high = None
        else:
            low_factor, high_factor = factors[confidence]
            low, high = likely * low_factor, likely * high_factor

    return Metrics(
        percent=percent,
        earned_points=earned_points,
        total_points=total_points,
        elapsed_minutes=elapsed,
        likely_minutes=likely,
        low_minutes=low,
        high_minutes=high,
        confidence=confidence,
        estimate_basis=basis,
        blockers=blockers,
        completed_tasks=completed,
        required_tasks=len(tasks),
        current_tasks=current,
    )


def format_duration(minutes: float | None) -> str:
    if minutes is None:
        return "unknown"
    rounded = max(0, int(round(minutes)))
    if rounded == 0:
        return "0m"
    days, remainder = divmod(rounded, 60 * 8)
    hours, mins = divmod(remainder, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if mins and len(parts) < 2:
        parts.append(f"{mins}m")
    return " ".join(parts)


def make_bar(percent: float, width: int, ascii_only: bool) -> str:
    filled = min(width, max(0, int(round(width * percent / 100))))
    full, empty = ("#", "-") if ascii_only else ("█", "░")
    return f"[{full * filled}{empty * (width - filled)}] {percent:.0f}%"


def required_goals(data: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for task in data["tasks"]:
        if not task.get("required", True):
            continue
        name = task.get("milestone") or task["title"]
        grouped.setdefault(name, []).append(task)

    goals: list[dict[str, Any]] = []
    for name, tasks in grouped.items():
        total = sum(float(task["weight"]) for task in tasks)
        earned = sum(float(task["weight"]) * float(task["progress"]) for task in tasks)
        goals.append(
            {
                "name": name,
                "percent": 100 * earned / total,
                "blocked": any(task.get("blocking", False) and float(task["progress"]) < 1 for task in tasks),
            }
        )
    return goals


def format_goal(goal: dict[str, Any], ascii_only: bool) -> str:
    percent = float(goal["percent"])
    if goal["blocked"]:
        marker = "[!]" if ascii_only else "!"
    elif percent >= 100:
        marker = "[x]" if ascii_only else "✓"
    elif percent > 0:
        marker = "[~]" if ascii_only else "◐"
    else:
        marker = "[ ]" if ascii_only else "○"
    return f"{marker} {goal['name']} ({percent:.0f}%)"


def render_text(data: dict[str, Any], metrics: Metrics, width: int, ascii_only: bool) -> str:
    project = data["project"]
    lines = ["Project progress", make_bar(metrics.percent, width, ascii_only), ""]
    lines.append(f"Project: {project['name']} — {project['goal']}")
    lines.append(f"Done means: {project['done_definition']}")
    lines.append(f"Scope: {project.get('scope_source', 'inferred')}")
    lines.append(
        f"Completed: {metrics.earned_points:g}/{metrics.total_points:g} weighted points "
        f"· {metrics.completed_tasks}/{metrics.required_tasks} required tasks done"
    )
    if metrics.current_tasks:
        lines.append(f"Current: {', '.join(metrics.current_tasks)}")

    if metrics.percent >= 100:
        lines.append("ETA: complete")
    elif metrics.blockers:
        remaining = format_duration(metrics.likely_minutes)
        lines.append(f"ETA: paused by blocker · estimated remaining active work {remaining}")
    elif metrics.likely_minutes is None:
        lines.append("ETA: not enough timing evidence · low confidence")
    else:
        lines.append(
            f"ETA: ~{format_duration(metrics.likely_minutes)} active work "
            f"({format_duration(metrics.low_minutes)}–{format_duration(metrics.high_minutes)}) "
            f"· {metrics.confidence}"
        )
    lines.append(f"Basis: {metrics.estimate_basis} · {format_duration(metrics.elapsed_minutes)} active work observed")
    lines.append(f"Blocked: {', '.join(metrics.blockers) if metrics.blockers else 'none'}")
    lines.append("")
    lines.append("Required goals:")
    lines.extend(format_goal(goal, ascii_only) for goal in required_goals(data))
    return "\n".join(lines)


def metrics_as_json(data: dict[str, Any], metrics: Metrics, width: int, ascii_only: bool) -> str:
    payload = {
        "project": data["project"],
        "bar": make_bar(metrics.percent, width, ascii_only),
        "percent": round(metrics.percent, 2),
        "earned_points": round(metrics.earned_points, 3),
        "total_points": round(metrics.total_points, 3),
        "completed_tasks": metrics.completed_tasks,
        "required_tasks": metrics.required_tasks,
        "elapsed_minutes": round(metrics.elapsed_minutes, 2),
        "likely_minutes": None if metrics.likely_minutes is None else round(metrics.likely_minutes, 2),
        "range_minutes": [
            None if metrics.low_minutes is None else round(metrics.low_minutes, 2),
            None if metrics.high_minutes is None else round(metrics.high_minutes, 2),
        ],
        "confidence": metrics.confidence,
        "estimate_basis": metrics.estimate_basis,
        "current_tasks": list(metrics.current_tasks),
        "blockers": list(metrics.blockers),
        "required_goals": required_goals(data),
    }
    return json.dumps(payload, indent=2, ensure_ascii=ascii_only)


def load_ledger(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"ledger not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
    errors = validate_ledger(data)
    if errors:
        raise ValueError("invalid ledger:\n- " + "\n- ".join(errors))
    return data


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="validate a progress ledger")
    validate_parser.add_argument("ledger", type=Path)

    render_parser = subparsers.add_parser("render", help="render progress and ETA")
    render_parser.add_argument("ledger", type=Path)
    render_parser.add_argument("--width", type=int, default=20)
    render_parser.add_argument("--ascii", action="store_true", dest="ascii_only")
    render_parser.add_argument("--json", action="store_true", dest="json_output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        data = load_ledger(args.ledger)
        if args.command == "validate":
            print(f"Ledger is valid: {args.ledger}")
            return 0
        if not 5 <= args.width <= 80:
            raise ValueError("--width must be between 5 and 80")
        metrics = calculate(data)
        if args.json_output:
            print(metrics_as_json(data, metrics, args.width, args.ascii_only))
        else:
            print(render_text(data, metrics, args.width, args.ascii_only))
        return 0
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
