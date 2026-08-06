# Progress ledger format

Read this reference when creating, updating, validating, or repairing `.project-progress.json` or a legacy `.codex/project-progress.json`.

## Schema

Use UTF-8 JSON with this shape:

```json
{
  "schema_version": 2,
  "project": {
    "name": "Example project",
    "goal": "Ship the requested outcome",
    "done_definition": "The user-visible acceptance test passes",
    "scope_source": "inferred",
    "started_at": "2026-08-06T09:00:00-07:00"
  },
  "tasks": [
    {
      "id": "implementation",
      "title": "Implement the required behavior",
      "milestone": "Build",
      "task_type": "implementation",
      "required": true,
      "weight": 5,
      "status": "in_progress",
      "progress": 0.5,
      "initial_estimate_minutes": 60,
      "elapsed_minutes": 35,
      "remaining_minutes": 45,
      "uncertainty": "medium",
      "blocking": false,
      "evidence": ["Core path implemented; focused test still failing"]
    }
  ],
  "forecast_history": [
    {
      "at": "2026-08-06T09:45:00-07:00",
      "active_elapsed_minutes": 25,
      "earned_points": 2,
      "total_points": 7,
      "likely_minutes": 80,
      "low_minutes": 32,
      "high_minutes": 210
    }
  ],
  "risks": [
    {
      "title": "External API behavior requires rework",
      "probability": 0.25,
      "impact_minutes": 45,
      "active": true
    }
  ],
  "updated_at": "2026-08-06T10:15:00-07:00"
}
```

Schema version 2 adds adaptive timing history while remaining backward compatible with version 1. Unknown additive fields are allowed so integrations can attach IDs or notes.

## Field rules

- `scope_source`: use `inferred` until the user or an authoritative specification confirms the scope; then use `confirmed`.
- `required`: only required tasks enter the percentage denominator. Use `false` for stretch goals and optional polish.
- `weight`: use a positive relative weight, normally one of `1, 2, 3, 5, 8`.
- `status`: use `not_started`, `in_progress`, `blocked`, or `done`.
- `progress`: use a number from `0` to `1`. `done` requires `1`; `not_started` requires `0`.
- `task_type`: use `planning`, `research`, `implementation`, `debugging`, `testing`, `release`, or `other`. Comparable task types share more timing evidence.
- `initial_estimate_minutes`: preserve the active-work estimate made before the task started. Never rewrite it to match actual performance; it is the baseline used to learn forecast error.
- `started_at`, `updated_at`, and `completed_at`: optional ISO-8601 timestamps that establish observation order. They never count as active time by themselves.
- `elapsed_minutes`: count cumulative active work only. Do not include time waiting on people, approvals, external jobs, or an idle task.
- `remaining_minutes`: give the current bottom-up estimate of active work remaining. Use `null` when there is no defensible estimate.
- `uncertainty`: use `low`, `medium`, or `high`.
- `blocking`: use `true` only when the task prevents completion of required scope now.
- `evidence`: list short, inspectable reasons for the current state. A done task needs at least one evidence item.
- `forecast_history`: append checkpoints in chronological order. Keep cumulative active minutes and earned/total points so recent pace and stalls can be measured. The CLI retains the most recent 50.
- `risks`: optional explicit events. `probability` is from `0` to `1`; `impact_minutes` is additional active work if the risk occurs.

## Calculation

For required tasks:

```text
earned points = sum(weight × progress)
total points = sum(weight)
completion = earned points ÷ total points
```

The renderer computes three adaptive ETA candidates:

```text
task ETA = Monte Carlo sum of calibrated remaining-task distributions and risks
whole-project ETA = active elapsed minutes ÷ earned points × remaining points
recent ETA = active minutes since checkpoint ÷ newly earned points × remaining points
```

Completed and partial tasks teach the model their multiplicative forecast error using `ln(actual / initial estimate)`. Recent, same-type tasks receive more influence. The center ETA is a reliability-weighted geometric combination of the available candidates. Active minutes without newly earned progress trigger a stall correction that moves the ETA upward.

The parenthesized range targets 90% coverage:

```text
low  = ETA × exp(-1.64485 × σ)
high = ETA × exp(+1.64485 × σ)
```

`σ` learns from task forecast errors, Monte Carlo spread, and disagreement between ETA candidates. Sparse data widen the same high-confidence range instead of switching between arbitrary low/medium/high thresholds. The JSON output exposes `calibration_stage` as `prior`, `learning`, or `calibrated` without cluttering the visual card. Read [eta-model.md](eta-model.md) for the detailed formula, research basis, and limits.

After updating progress or active minutes, record a checkpoint before reporting:

```text
node <skill-directory>/scripts/progress.mjs checkpoint .project-progress.json
```

Rendered durations use eight active-work hours per displayed `d`. They are effort durations, not calendar-day promises.

## Scope changes

Before changing required tasks or weights, render or record the prior percentage. After the update, report:

```text
Scope changed: 62% → 51%. Added required production verification after the acceptance bar was clarified.
```

Do not rewrite historical elapsed time or initial estimates. Add or remove required scope explicitly and preserve evidence notes needed to explain the change.
