# Project Progress

An ETA-first Agent Skill and dependency-free NPX tool for ChatGPT, Codex, Claude Code, and compatible skill hosts. It turns project evidence into an honest completion percentage, one ETA with an uncertainty range, and the work happening now.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ GOAL  Ship the public beta                                           │
├──────────────────────────────────────────────────────────────────────┤
│ ETA                                                                  │
│ ~52m (22m–2h 6m) · high confidence                                   │
│ 🟩🟩🟩🟩🟩🟩🟩⬜⬜⬜                                             71% │
├──────────────────────────────────────────────────────────────────────┤
│ NOW  Verify production path                                          │
└──────────────────────────────────────────────────────────────────────┘
```

## Install locally

Install for both OpenAI clients and Claude Code:

```bash
npx codex-project-progress@latest install
```

The default `all` target installs the skill in:

- `~/.agents/skills/track-project-progress` for ChatGPT Desktop, Codex CLI, and the Codex IDE extension.
- `~/.claude/skills/track-project-progress` for Claude Code.

Install only one target when preferred:

```bash
npx codex-project-progress@latest install --target openai
npx codex-project-progress@latest install --target claude
```

Older Codex builds that still load personal skills from `~/.codex/skills` can use:

```bash
npx codex-project-progress@latest install --target codex-legacy
```

Use `--force` to replace an existing copy. The installer moves the previous copy to a timestamped backup before replacing it.

## Use it in chat

Ask naturally:

```text
How far through this project are we? Show the ETA and progress card.
```

Or invoke the skill directly:

- ChatGPT: select `@track-project-progress` and ask it to reassess the project.
- Codex: `Use $track-project-progress to reassess this project.`
- Claude Code: `/track-project-progress reassess this project.`

One-off assessments are read-only. Ongoing tracking uses the host-neutral `.project-progress.json` ledger in the project root. Existing `.codex/project-progress.json` ledgers remain supported.

Chat cards are always emitted inside a fenced `text` block. This keeps the borders, spacing, ETA hierarchy, and progress bar together in a monospaced bubble instead of allowing the chat renderer to flatten them into ordinary text.

## Client support

| Surface | Supported path |
|---|---|
| Terminal | Run the dependency-free NPX renderer directly |
| ChatGPT Desktop | Install the OpenAI skill or packaged plugin |
| Codex Desktop, CLI, and IDE | Install the OpenAI skill |
| Claude Code | Install the Claude target |
| ChatGPT web or Claude cloud chats | Install or upload the packaged skill/plugin in that account |
| Other agents | Copy `skills/track-project-progress` into a compatible Agent Skills directory |

Local installation cannot silently add a skill to a cloud account. Cloud ChatGPT and Claude surfaces require their normal account-side plugin or skill installation step.

## OpenAI plugin package

The repository includes `.codex-plugin/plugin.json`, so the same workflow can be tested and submitted as an OpenAI plugin shared by ChatGPT and Codex. The NPM installer remains the fastest route for local clients; public appearance in the universal Plugins Directory requires OpenAI's plugin submission process.

## CLI

Try the visualization without installing:

```bash
npx codex-project-progress@latest demo
```

Render or validate a tracked project:

```bash
npx codex-project-progress render .project-progress.json
npx codex-project-progress render .project-progress.json --theme compact
npx codex-project-progress render .project-progress.json --markdown
npx codex-project-progress render .project-progress.json --ascii --no-color
npx codex-project-progress render .project-progress.json --json
npx codex-project-progress validate .project-progress.json
npx codex-project-progress checkpoint .project-progress.json
```

Available themes are `box`, `compact`, and `plain`. Interactive terminals use ANSI color. Unicode chat surfaces use colored emoji bars: green for active progress, red for blockers, and blue for complete.

## How the estimate works

The percentage uses earned weighted points rather than a raw task count. Required implementation, verification, deployment, and acceptance work can carry different weights, and a task reaches done only when its evidence exists.

The ETA is active work time, not a calendar promise. Version 0.3 combines three forecasts: a Monte Carlo simulation of calibrated remaining tasks, whole-project throughput, and recent throughput since the previous checkpoint. It learns each task type's multiplicative forecast error from the original estimate versus actual active time. When work consumes time without producing progress, the stall correction moves the ETA upward automatically.

The parenthesized interval targets 90% coverage. `high confidence` describes that deliberately wide range, not certainty that the center number is exact. Sparse data, task uncertainty, model disagreement, and explicit risks widen the interval; repeated comparable results can narrow it. Waiting, idle time, and unattended external jobs are excluded, and blocking dependencies pause the ETA.

The full formula and its research basis are documented in [`references/eta-model.md`](skills/track-project-progress/references/eta-model.md).

## Test and develop

The package uses Node's built-in test runner and has no runtime dependencies.

```bash
npm test
npm run test:package
npm pack --dry-run
```

## License

MIT
