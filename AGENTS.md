# Agent Instructions

The canonical, vendor-neutral **agent-context file** for this repo
([ENG-0006](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0006-agentic-primitives-governance.md)).
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.cursor/rules/` are thin
adapters that point here and carry only genuinely vendor-specific content — a
shared fact stated in two agent files is a bug, not redundancy.

Read `CONTRIBUTING.md`, then the guide it links:
[`docs/Contributing.md`](docs/Contributing.md), the canonical contributor and
agent workflow.

**This file is a map, not a manual.** It carries what an agent cannot derive
from the code, the ESLint config, or CI; depth lives in [`docs/`](docs/README.md)
and loads on demand. Its length ratchets downward like a coverage floor
(`npm run lint:agent-context`) — growth needs a reason in the PR that adds it.

**Maintenance convention:** when workflow, gates, or invariants change, update
this file in the same PR as the change — never after the fact.

## Communication

- Be brief: minimum words, bullets over paragraphs, no preamble, recap, or filler.
- Fix the problem; no sycophancy, apologies, or narrating past mistakes unless
  required for the fix.
- On correction: one-sentence restatement of updated requirements, then proceed.
- Disagree plainly when mistaken; cite code or docs.
- Do not narrate unsolicited intent or process, announce next steps, or confess
  partial completion. The pre-edit checkpoints in **Before Changing Code** are
  exempt — deliver those once, then implement without ongoing narration.
- Status updates belong in issue comments during issue work, not in chat unless
  the user asked for progress.

## Before Changing Code

- **New issue work:** investigate and root-cause (or confirm scope), then share a
  concise working note covering the problem, cause or scope, intended changes,
  assumptions, and likely tradeoffs. This keeps the user oriented; it is not an
  approval gate. Proceed from the user's stated goal, and surface only decisions
  that would materially change scope or risk.
- **Shared issue context:** add the same working note to the issue (issue comment
  per the claim flow in `docs/Contributing.md`) so the user and other
  contributors can work from the same information.
- **During implementation:** post issue comments for each meaningful change
  slice: what changed and why.
- **Before editing:** state in one short line each: likely fix, why it may not
  work, confidence (low/medium/high), possible regressions. Then implement.

## Working Agreement

- **Open a PR early; a draft is optional, finishing it is not.** Draft is a
  starting state, never an ending state.
- **Take the PR out of draft the moment the work is complete.** As soon as
  `npm run ci` passes locally (plus `test:e2e` / `test:stories:ci` where they
  apply), run `gh pr ready <n>` without being asked. **A draft PR is reviewed by
  nobody — not the owner, not the Codex bot** — so a PR abandoned in draft is
  indistinguishable from work never done, and it hides the one signal the owner
  has that a slice is finished. Check
  `gh pr list --state open --json number,isDraft,title` before reporting
  completion. If something genuinely blocks ready-for-review, name the blocker on
  the PR and in your summary; silence reads as abandonment. **"Ready for review"
  is the definition of done** — "pushed" and "CI is green" are not.
- **Documentation-only work goes through a PR like any other change.** ADRs and
  SOPs live in `docs/`; the former "wiki-only work has no PR" exemption no longer
  applies.
- **Commit frequently.** Small, coherent commits per meaningful slice; push
  regularly. No end-of-session mega-commits.
- **Queue the merge yourself.** Right after `gh pr ready`, run
  `gh pr merge <n> --auto --merge`. The branch updater and strict checks keep the
  PR current; do not manually rebase or merge `main` into a merely-behind branch.
  Details are in
  [CI Identity And Tokens](docs/CI-Identity-And-Tokens.md) → Merge automation.
- **Drafts run only the `Changesets` gate.** Every PR adds a semantic changeset;
  a ready transition without one returns the PR to draft. Run `npm run ci`,
  `test:e2e`, and `test:stories:ci` locally as applicable. After pushing the
  final SHA, an agent may dispatch CI for exact-SHA preflight and wait for
  success before `gh pr ready`; otherwise the ready transition runs the
  complete suite.
- **Use the status footer only during an active validation/build run or while
  pairing on manual testing.** Omit it from routine turns. When it applies:
  - `Working dir:` absolute path of the active worktree/checkout
  - `Build:` result of the relevant gates (`npm run ci` pass/fail, or "not run"
    with the reason)
  - `Commit:` current branch + short SHA, noting any dirty state

## Architecture

Electron process layout ([ADR-0003](docs/adr/ADR-0003-Desktop-Stack.md)),
enforced with `no-restricted-imports` in `eslint.config.js`:

- `src/main/` — main process (lifecycle, windows, IPC handlers). May import
  `src/shared/`, never `src/renderer/`.
- `src/preload/` — contextBridge only; builds the typed `window.overlook`
  surface. May import `src/shared/`, never `src/main/`.
- `src/renderer/` — sandboxed React app. May import `src/shared/` (types + pure
  logic), never `src/main/` or `src/preload/`.
- `src/shared/` — pure, process-free modules (IPC contract registry in
  `shared/ipc/`, domain logic). Imports nothing process-specific.

All renderer↔main traffic goes through the zod-validated channel/event registry
in `src/shared/ipc/channels.ts` — never raw `ipcRenderer`.

`src/renderer/src/styles/tokens/*.css` (ported verbatim from
`design/handoff/tokens/`, the committed design handoff package) is the single
styling source of truth. **No magic values** in renderer styles: color, type,
spacing, radii, elevation, and motion always reference a token (`var(--…)`).
Machine data (EXIF, counts, sync states) renders with the `.mono-data` utility.

## Product Invariants

- All application commands project from the typed shared registry governed by
  [ADR-0024](docs/adr/ADR-0024-Shared-Command-Registry-And-Application-Menu.md).
  Native menus, shortcuts, context menus, toolbars, and Quick Actions may show
  different subsets, but must not duplicate command identity, labels, enablement
  policy, shortcuts, or execution paths.

## Branch And GitHub Hygiene

- Development is trunk-based: short-lived branches cut from latest `main`, merged
  back via PR. No separate integration branch.
- **Merge only into `main`. Do not stack branches.** Every branch is cut from the
  current `main` tip and every PR bases on `main`. Multiple agents run here in
  parallel: a stacked branch breaks the moment the branch below it merges. If
  your work genuinely depends on an unmerged change, wait for that PR to merge,
  then branch from the updated `main`.
- Check `git status` before changing anything; preserve unrelated user work.
- Open PRs with explicit closing references (`Closes #N`) when the PR completes
  an issue — the close-linked-issues workflow parses the merged PR body.
- Review/issue feedback gets a visible reply before the thread is resolved: what
  commit fixed it, why no action was needed, or what linked follow-up owns it.
  Never resolve threads silently.
- Identity, tokens, third-party-action blast radius, and conflict recovery:
  [CI Identity And Tokens](docs/CI-Identity-And-Tokens.md).

## Documentation

- Repo-first: long-lived docs, SOPs, ADRs, and agent pitfalls live in
  [`docs/`](docs/README.md) — ADRs in [`docs/adr/`](docs/adr/), acceptance and
  manual test plans in [`docs/acceptance/`](docs/acceptance/), user stories in
  [`docs/stories/`](docs/stories/). The
  [Repo Documentation Pointer Map](docs/Repo-Documentation-Pointer-Map.md) says
  which page is canonical for a given repo path. The GitHub wiki is retired; its
  pages are stubs kept only so existing links resolve
  ([ENG-0003](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0003-repo-is-documentation-source-of-truth.md)).
- **ADR gate:** an issue labeled `adr` changes an architectural contract — do not
  start its implementation until the governing ADR in [`docs/adr/`](docs/adr/)
  reads `Status: Accepted` (precedent: ADR-0022 ↔ #483, ADR-0023 ↔ #534). The
  issue's "ADR gate" section names the cluster: clustered issues share one ADR,
  written at the number their tracking issue reserves, indexed, and linked from
  every clustered issue. Semantic changes after acceptance go through an ADR
  amendment first, code second.

## Validation

Before claiming done:

```sh
npm run ci              # interop acceptance, lint chain, format, changesets,
                        # acceptance + a11y budgets, docs:gov, test:cov, build
npm run test:e2e        # additionally, for E2E-relevant changes
npm run test:stories:ci # additionally, for renderer/story-relevant changes
```

- Two gates read an external checkout: `DOCS_GOV_TOOLING_ROOT` (a
  `qwts/playbook-engineering` checkout at `v1`) and `INTEROP_IMAGE_TRAIL_ROOT`.
- **Floors are ratchets — raise them as quality improves, never lower them to
  pass.** The a11y violation budget ratchets the other way: its counts only
  shrink, and coming in under budget fails until the entry is tightened.
- **Never push a fix for a red check without running that same check locally
  first.** CI is a verifier, not a test runner. A deterministic gate that fails
  in CI means the push skipped local validation. E2E under Xvfb is the one lane
  that can legitimately disagree with a local pass; say so on the PR when
  claiming it.
- **Never bypass the Husky pre-push hook with `--no-verify`.** It runs the exact
  `npm run lint` entrypoint the hosted lint job uses.
- **Never suppress an a11y rule bare** — every `eslint-disable` carries a reason
  or the issue that owns the debt.
- Do not report a build you did not run.

Gate-by-gate detail, ratchet values, the three a11y lanes, license policy,
dependency pins and overrides, packaging checks, and the release/signing flow:
[Validation And Release Gates](docs/Validation-And-Release-Gates.md).

## Process-Tree Guard

- Every test entrypoint (`npm test`, `test:dom`, `test:cov`, `test:stories*`,
  `test:e2e*`, `test:perf`) runs through `scripts/run-guarded.mjs`: an aggregate
  RSS ceiling over the whole descendant tree, a per-process Node heap cap, a
  wall-clock timeout, and one guarded run at a time per worktree.
- Never invoke `electron --test`, `node --test`, `.test-dist`/`.test-dist-dom`
  output, `playwright test`, `test-storybook`, or `c8` directly, and never call
  `:run`/`:inner` npm scripts. Claude Code and Cursor deny these mechanically via
  the checked-in hooks in `.claude/settings.json` and `.cursor/hooks.json`;
  Codex and raw terminals rely on this rule.
- If a command returns while still running, poll or terminate it before launching
  anything else. "Another guarded run is active" is a stop, not a prompt to retry.
- A run killed for `rss-limit`/`timeout` is a real failure: read
  `.guard/last-run.json`, report it, and do not rerun with a higher limit to make
  it pass. Knobs and details: [`docs/agent-process-guard.md`](docs/agent-process-guard.md).

## Tooling

- Node is pinned in `.nvmrc`; select it (`nvm use`) before installing. CI reads
  the same file — bump it to move local and CI together.
- Install with `npm ci`; it also installs the husky pre-commit hook (lint-staged:
  `eslint --fix` + prettier on staged files).
- The `/check` command (`.claude/commands/check.md`) wraps the full gate run.
- Invoke tools through `PATH` (or `npx`); never hardcode machine-specific paths.
- Local macOS `test:e2e` windows stay hidden and must never activate or take
  desktop focus, including through `second-instance`, `open-file`, or Dock
  activation. Route every native restore/show/focus path through
  `e2e-window-visibility.ts`; use `test:e2e:visible` only for deliberate manual
  debugging.

## Agent Primitives

The files that steer agents — this one, the vendor adapters, `.claude/commands/`,
hooks, and tool permissions — are **code**: reviewed by PR, least-privilege, and
never carrying secrets. `npm run lint:agent-context` enforces the length ratchet,
the adapter pointers, and cross-file duplication;
`tests/tooling/agent-primitives.test.ts` locks the guard hooks and permission
shape, because a governance sync once replaced `.claude/settings.json` wholesale
and silently dropped the process-guard hook.

Instruction changes that claim to improve agent behavior cite evidence against
the [Agent Golden Tasks](docs/Agent-Golden-Tasks.md) set. "It reads better" is
not evidence.
