---
name: track-project-progress
description: Assess and track a project's evidence-weighted completion percentage, visual progress bar, completed and remaining work, elapsed effort, blockers, and ETA range. Use when a user asks how far through a project or task the agent is, requests a percent complete or progress bar, asks how much work or time remains, wants an ETA, or asks the agent to keep progress visible during ongoing work.
---

# Track Project Progress

Give an honest, evidence-backed view of what the project is, what “done” requires, how much required work is complete, and how long the remainder may take.

## Choose the mode

- Use **snapshot mode** for a one-off progress or ETA question. Inspect the available evidence and report inline without creating files.
- Use **tracking mode** when the user asks to keep, maintain, or repeatedly update progress. Persist the host-neutral ledger at `.project-progress.json` in the relevant project root. Reuse a legacy `.codex/project-progress.json` ledger when it already exists.
- Reuse an existing ledger when present, but verify it against current files, tests, logs, tickets, and the user's latest requirement before trusting it.

Do not mutate project files for a read-only status request. Follow all workspace instructions before creating or editing a ledger.

## Build the project model

1. State the project in one sentence.
2. State the definition of done as an observable outcome.
3. Decompose required scope into 3–8 milestones and concrete tasks. Exclude optional improvements from the denominator unless the user includes them in scope.
4. Assign relative weights from `1, 2, 3, 5, 8` based on effort, uncertainty, and consequence. Do not treat every task as equal.
5. Assign task progress from verifiable sub-results. Require evidence for `done`; use `0`, `0.25`, `0.5`, or `0.75` for partially complete work unless a finer value is justified by explicit subtasks.
6. Record elapsed active-work minutes, remaining active-work minutes, uncertainty, blockers, and short evidence notes when that information exists.

Treat the user's latest clarified requirement as the completion contract. If scope changes, recalculate the denominator and explicitly report the old percentage, new percentage, and reason. Never freeze or inflate the percentage to avoid a visible regression.

## Judge evidence

Prefer evidence in this order:

1. User-observed acceptance or production/live verification when that is the stated bar.
2. Passing acceptance tests or direct runtime evidence.
3. Passing focused tests plus inspected implementation.
4. Source changes without runtime verification.
5. Inference or intent only.

Do not mark a required task complete because work was attempted, code exists, or a nearby case passed. A required obligation present upstream but missing downstream remains incomplete.

## Calculate progress and ETA

Calculate completion as earned weighted points divided by total required weighted points. Do not use raw task counts when weights differ.

Estimate remaining active-work time from both:

- bottom-up estimates for incomplete tasks; and
- observed throughput from elapsed active time per earned weighted point.

Blend the two only when both have evidence. Early estimates must have wider ranges and low confidence. Exclude time spent waiting for the user, approvals, external systems, or unattended processes from active-work throughput. If a required task has an unresolved blocking dependency, show the ETA as paused or blocked rather than inventing a finish time.

Read [references/ledger-format.md](references/ledger-format.md) before creating or repairing a ledger, changing the calculation, or explaining the detailed math.

For tracking mode, validate and render with:

```text
node <skill-directory>/scripts/progress.mjs validate .project-progress.json
node <skill-directory>/scripts/progress.mjs render .project-progress.json --markdown
```

Use the default `box` theme for the first assessment, scope changes, blockers, and milestone completions. Use `--theme compact` for shorter ongoing updates. Use `--ascii` if Unicode blocks do not render correctly, `--no-color` for captured logs, and `--json` when another tool needs structured output.

## Report the status

Lead meaningful updates with the goal, a dominant ETA block, the percentage bar, and `NOW` as the only secondary status line. Put the ETA before the bar. Do not add separate labels for likely range, active work, milestones, or completed work.

In every chat surface, put the entire card in its own fenced `text` code block so it renders as one contained, monospaced unit. Never emit the card as ordinary Markdown paragraphs, even for compact updates. When the renderer can run, use `--markdown` and paste its stdout verbatim. Keep any explanation outside the fence. Omit `--markdown` only when a human runs the command directly in a terminal.

In snapshot mode, or when the renderer cannot run, manually use this fenced shape:

```text
GOAL  <goal>
ETA   <expected duration> (<uncertainty range>) · <confidence>
[🟩🟩🟩🟩🟩🟩⬜⬜⬜⬜] <percentage>
NOW   <task currently in progress>
```

Keep done definitions, scope details, weighted-point math, milestone breakdowns, and evidence outside the visual unless the user requests them or they are necessary to explain a paused or uncertain ETA. Still maintain that evidence internally so the percentage and ETA remain honest. Label inferred scope or weighting briefly when it materially affects confidence.

Keep a manually rendered bar to 10 colored emoji cells or 20 monochrome text cells. Use green for active progress, amber for low confidence, red when blocked, and blue when complete. Prefer the bundled boxed renderer when a ledger exists. Use a milestone table instead of a list only when weights, owners, or blockers materially clarify the estimate.

In ongoing work, report at the start, after a completed milestone, when progress changes by at least five percentage points, when the ETA changes materially, when blocked, and at completion. Do not emit the same unchanged card after every tool call.

## Completion rules

- Show `100%` only when every required task meets the observable definition of done.
- If implementation is finished but verification is pending, keep verification as remaining weighted work.
- Label all unverified project interpretations and assumptions.
- Prefer an honest ETA such as `~2h (1h 20m–3h) · medium confidence` over a precise timestamp unsupported by work schedules.
- At completion, replace the ETA with `complete` and summarize the evidence that closed the final requirement.
