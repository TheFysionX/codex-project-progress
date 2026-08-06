# Codex Project Progress

An installable Codex skill and dependency-free NPX tool that turns project evidence into an honest completion percentage, ETA-first progress card, and current-work signal.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Project Atlas · Ship the public beta                             71% │
│ ████████████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░ │
├──────────────────────────────────────────────────────────────────────┤
│ ETA                                                                  │
│ ~52m ACTIVE WORK                                                     │
│ Likely range 36m–1h 18m · medium confidence                          │
├──────────────────────────────────────────────────────────────────────┤
│ NOW  Verify production path                                          │
└──────────────────────────────────────────────────────────────────────┘
```

## Install with NPX

```bash
npx codex-project-progress install
```

This installs `track-project-progress` in `~/.agents/skills`, the user-level skill location documented for Codex. Codex detects new skills automatically; restart it if the skill does not appear.

Try the renderer without installing anything:

```bash
npx codex-project-progress demo
```

## Use in Codex

Natural requests can invoke the skill:

```text
How far through this project are we? Show the required goals, percentage, and ETA.
```

```text
Keep the project progress card updated while you finish this task.
```

Or invoke it explicitly:

```text
Use $track-project-progress to reassess this project from the current evidence.
```

One-off assessments are read-only. Ongoing tracking uses `.codex/project-progress.json` in the relevant project.

## CLI

```bash
# Install the skill
npx codex-project-progress install

# Render a ledger with the boxed theme
npx codex-project-progress render .codex/project-progress.json

# Use the shorter update format
npx codex-project-progress render .codex/project-progress.json --theme compact

# Work in terminals without Unicode support
npx codex-project-progress render .codex/project-progress.json --ascii --no-color

# Return structured calculations
npx codex-project-progress render .codex/project-progress.json --json

# Validate a ledger
npx codex-project-progress validate .codex/project-progress.json
```

Available themes are `box`, `compact`, and `plain`. Color is automatic in interactive terminals and can be controlled with `--color always`, `--color never`, or `--no-color`.

## Install directly from GitHub

Ask Codex:

```text
Use $skill-installer to install https://github.com/TheFysionX/codex-project-progress/tree/main/skills/track-project-progress
```

You can also copy `skills/track-project-progress` to `~/.agents/skills/track-project-progress`.

## How the estimate works

The percentage uses earned weighted points, not a raw task count. Required implementation, verification, deployment, and user acceptance can carry different weights. A task only reaches done when its stated evidence exists.

The ETA represents remaining active work. It excludes time waiting for users, approvals, external systems, or idle processes. When enough history exists, it blends bottom-up task estimates with observed time per earned weighted point and widens the range when evidence is sparse or uncertain. Blocking dependencies pause the ETA rather than producing a fictional finish time.

## Test and develop

The package uses Node's built-in test runner and has no runtime dependencies.

```bash
npm test
npm run test:package
npm pack --dry-run
```

The suite covers weighted progress, optional-scope exclusion, evidence requirements, uncertainty ranges, blockers, completed projects, boxed/compact/ASCII rendering, CLI JSON output, and installation into a clean temporary skill directory.

## License

MIT
