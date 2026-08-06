# Progress ledger format

Read this reference when creating, updating, validating, or repairing `.codex/project-progress.json`.

## Schema

Use UTF-8 JSON with this shape:

```json
{
  "schema_version": 1,
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
      "required": true,
      "weight": 5,
      "status": "in_progress",
      "progress": 0.5,
      "elapsed_minutes": 35,
      "remaining_minutes": 45,
      "uncertainty": "medium",
      "blocking": false,
      "evidence": ["Core path implemented; focused test still failing"]
    }
  ],
  "updated_at": "2026-08-06T10:15:00-07:00"
}
```

Unknown additive fields are allowed so integrations can attach IDs or notes. Keep the required fields compatible with schema version 1.

## Field rules

- `scope_source`: use `inferred` until the user or an authoritative specification confirms the scope; then use `confirmed`.
- `required`: only required tasks enter the percentage denominator. Use `false` for stretch goals and optional polish.
- `weight`: use a positive relative weight, normally one of `1, 2, 3, 5, 8`.
- `status`: use `not_started`, `in_progress`, `blocked`, or `done`.
- `progress`: use a number from `0` to `1`. `done` requires `1`; `not_started` requires `0`.
- `elapsed_minutes`: count active work only. Do not include time waiting on people, approvals, external jobs, or an idle task.
- `remaining_minutes`: give the current bottom-up estimate of active work remaining. Use `null` when there is no defensible estimate.
- `uncertainty`: use `low`, `medium`, or `high`.
- `blocking`: use `true` only when the task prevents completion of required scope now.
- `evidence`: list short, inspectable reasons for the current state. A done task needs at least one evidence item.

## Calculation

For required tasks:

```text
earned points = sum(weight × progress)
total points = sum(weight)
completion = earned points ÷ total points
```

The renderer computes two ETA candidates:

```text
bottom-up ETA = sum known remaining estimates, scaled for uncovered remaining weight
observed ETA = active elapsed minutes ÷ earned points × remaining points
```

When both exist, observed throughput receives more influence as completed-task evidence accumulates, up to 75%. A critical blocker pauses the ETA. Confidence rises only with completed tasks, estimate coverage, later-stage progress, and lower remaining uncertainty.

The displayed ranges intentionally widen uncertainty:

- high confidence: approximately `0.85×–1.25×` the likely estimate
- medium confidence: approximately `0.70×–1.50×`
- low confidence: approximately `0.50×–2.00×`

These are communication guardrails, not statistical confidence intervals.

## Scope changes

Before changing required tasks or weights, render or record the prior percentage. After the update, report:

```text
Scope changed: 62% → 51%. Added required production verification after the acceptance bar was clarified.
```

Do not rewrite historical elapsed time. Add or remove required scope explicitly and preserve evidence notes needed to explain the change.
