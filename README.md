# Codex Project Progress

An installable Codex skill that turns project evidence into an honest completion percentage, a visual progress bar, and an ETA range.

```text
Project progress
[████████████░░░░░░░░] 60%

Project: Partner portal — ship the approved login flow
Done means: the production login path passes the user-visible acceptance test
Scope: confirmed
Completed: 12/20 weighted points · 4/7 required tasks done
Current: Verify production behavior
ETA: ~1h 40m active work (1h 10m–2h 30m) · medium confidence
Blocked: none

Required goals: ✓ scope · ✓ implementation · ◐ verification · ○ production acceptance
```

The skill first infers the project and its observable definition of done. It then breaks required scope into weighted tasks, checks completion evidence, measures active work separately from waiting, and blends bottom-up estimates with observed throughput. Early estimates stay deliberately wide; blockers pause the ETA instead of producing false precision.

## Install with Codex

Ask Codex to install the skill from this repository:

```text
Use $skill-installer to install https://github.com/TheFysionX/codex-project-progress/tree/main/skills/track-project-progress
```

The skill becomes available on the next Codex turn.

For a manual install, copy `skills/track-project-progress` into `~/.codex/skills/track-project-progress` (macOS/Linux) or `%USERPROFILE%\.codex\skills\track-project-progress` (Windows).

## Use

Natural requests trigger the skill, including:

```text
How far through this project are we? Show me a percentage and ETA.
```

```text
Keep a progress bar and time estimate updated while you finish this task.
```

```text
Use $track-project-progress to reassess the remaining work from the current repo evidence.
```

One-off requests are read-only. Ongoing tracking uses `.codex/project-progress.json` in the relevant project and the bundled standard-library Python renderer.

## What the percentage means

The bar uses earned weighted points, not the raw number of checked boxes. Required implementation, verification, deployment, and user acceptance can carry different weights. A task only reaches done when its stated evidence exists, and a clarified scope change is allowed to move the percentage backward with an explanation.

The ETA is remaining active-work time. It excludes time waiting for users, approvals, or external systems. When enough evidence exists, it blends per-task estimates with the pace observed so far and reports a low-, medium-, or high-confidence range.

## Repository layout

```text
skills/track-project-progress/  Installable Codex skill
tests/                          Renderer and calculation tests
```

## Development

Run the test suite with Python 3.10 or newer:

```text
python -m unittest discover -s tests -v
```

The runtime script has no third-party dependencies.

## License

MIT
