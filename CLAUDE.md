# Overlook — Claude Code guide

Start with **[`AGENTS.md`](AGENTS.md)**. It is the canonical agent-context file
and holds everything shared: communication rules, pre-edit checkpoints, the
working agreement, architecture and design-token invariants, GitHub hygiene, the
validation gates, and the process-tree guard. Do not restate any of it here — a
shared fact in two agent files is a bug
([ENG-0006](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0006-agentic-primitives-governance.md)).

This file carries only what is specific to Claude Code.

## Checked-in Claude configuration

`.claude/settings.json` registers two hooks, both load-bearing:

- **`PreToolUse` on `Bash`** runs the shared guard with `--protocol=claude`,
  denying direct `electron --test`, `node --test`, `.test-dist`/`.test-dist-dom`
  execution, `playwright test`, `test-storybook`, `c8`, and `:run`/`:inner`
  scripts, and steering you to the guarded entrypoints. Because project settings
  are checked in, this applies to terminal, IDE, and headless runs alike.
- **`WorktreeCreate`** mints the per-worktree bot identity from
  `qwts/playbook-engineering`.

`tests/tooling/agent-primitives.test.ts` locks both hooks and the
least-privilege permission shape. It exists because a governance sync once
replaced that file wholesale and silently removed the guard hook — if you are
editing `.claude/settings.json`, expect that test to have an opinion.

## Slash commands

**`/check`** (`.claude/commands/check.md`) runs every validation gate in order,
reports each result explicitly, and restarts the sequence if a fix edits a
tracked file. Prefer it over running gates ad hoc when you want a clean,
reportable pass.

Commands are reviewed like source: a new one lands by PR with the same scrutiny
as code.

## Working in a bot worktree

Commits made with `git commit` here cannot be Verified — the worktree sets
`commit.gpgsign=false` deliberately, since signing a bot's commit with the
human's key shows Unverified. Replay commits through the Git Data API with the
`signed-commit` skill before opening the PR; GitHub signs them server-side. The
identity and token rules behind this are in
[CI Identity And Tokens](docs/CI-Identity-And-Tokens.md).
