# Agent Instructions

Repo-local agent orientation layer — the **shared agent-context file**; other
agent files (`CLAUDE.md`, `.github/copilot-instructions.md`) point here instead
of duplicating. Read `CONTRIBUTING.md` first, then the contributor guide
it links: [`docs/Contributing.md`](docs/Contributing.md).

Keep this file compact; use references instead of duplicating long procedures.
Detailed workflow, SOP, and project documentation belong in
[`docs/`](docs/README.md).

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
  per the claim flow in `docs/Contributing.md`) so the user and other contributors can work from the
  same information.
- **During implementation:** post issue comments for each meaningful change
  slice: what changed and why.
- **Before editing:** state in one short line each: likely fix, why it may not
  work, confidence (low/medium/high), possible regressions. Then implement.

## Working Agreement

- **Open a PR early. A draft is optional — finishing it is not.** After claiming
  an issue and branching, push the branch and open a pull request. Opening it as
  a **draft** is welcome and encouraged when the first commit is scaffolding or a
  failing test; it makes work in flight visible. Opening it ready straight away is
  equally fine. Draft is a **starting state, never an ending state**.
- **Take the PR out of draft the moment the work is complete.** As soon as
  `npm run ci` passes locally (plus `test:e2e` / `test:stories:ci` where they
  apply), run `gh pr ready <n>`. Do not wait to be asked. **A draft PR is
  reviewed by nobody — not the owner, not the Codex bot — so a PR abandoned in
  draft is the same as never doing the work**: from the outside it is
  indistinguishable from abandoned work, and it hides the one signal the owner
  has that a slice is finished. Never end a session with your own PR still in
  draft — check `gh pr list --state open --json number,isDraft,title` before
  reporting completion. If something genuinely blocks ready-for-review, say so on
  the PR and in your summary and name the blocker; silence reads as abandonment.
  **"Ready for review" is the definition of done for a code slice** — "pushed"
  and "CI is green" are not. Documentation-only work — an ADR, an SOP — now
  lives in `docs/` and goes through a PR like any other change; the former
  "wiki-only work has no PR" exemption (precedent
  [#394](https://github.com/qwts/photos/issues/394) /
  [#402](https://github.com/qwts/photos/issues/402)) no longer applies.
- **Commit frequently.** Small, coherent commits at each meaningful slice of
  work; push regularly so CI and the draft PR stay current. No end-of-session
  mega-commits.
- **Queue the merge yourself.** Right after `gh pr ready`, run
  `gh pr merge <n> --auto --merge`. GitHub's real merge queue is
  organizations-only, so this repo runs the hand-rolled equivalent
  (`.github/workflows/auto-update-prs.yml`): after every merge to `main` the
  workflow updates each open ready PR by **merging `main` into it** (GitHub's
  update-branch API — no rebase, no force-push), which fires that PR's CI on
  the true merged state; the ruleset's strict up-to-date requirement stops
  auto-merge from landing a stale-green combination, and auto-merge lands the
  PR as a merge commit once its updated head is green and review threads are
  resolved. **Never manually rebase, merge `main` in, or "update" a branch
  that is merely behind `main`** — that chore is the automation's job. Touch
  history yourself only to resolve a real conflict (the workflow skips
  conflicting branches; the PR shows CONFLICTING — see Branch And GitHub
  Hygiene). The automation no longer rewrites your branch, so a plain
  `git pull` before pushing fast-forwards cleanly. Dependabot branches are
  excluded — comment `@dependabot rebase` on those instead. After any update
  that changes `package-lock.json`, run `npm ci` before trusting local gates: a
  stale install fails E2E in ways that look like flakes (an Electron bump
  landing mid-session produced two identical timeout failures this way).
- **Draft CI is the fast lane only.** On draft PRs CI runs the deterministic
  gates (lint, format, acceptance/a11y budgets, unit+coverage, build) and skips
  the browser lanes (Storybook interaction tests, Electron E2E). The full suite
  runs when the PR opens ready or leaves draft — so the local `test:e2e` /
  `test:stories:ci` runs required before `gh pr ready` are not a formality:
  the ready flip is the first time CI verifies them.
- **Use the status footer only during an active validation/build run or while
  pairing with the user on manual testing.** Omit it from routine turns. When it
  applies, report these three lines:
  - `Working dir:` absolute path of the active worktree/checkout
  - `Build:` result of the relevant gates (e.g. `npm run ci` pass/fail, or
    "not run" with the reason)
  - `Commit:` current branch + short SHA, with a dirty-state note if
    uncommitted changes remain

## Product Invariants

- All application commands project from the typed shared registry governed by
  [ADR-0024](docs/adr/ADR-0024-Shared-Command-Registry-And-Application-Menu.md).
  Native menus, shortcuts, context menus, toolbars, and Quick Actions may show
  different subsets, but must not duplicate command identity, labels,
  enablement policy, shortcuts, or execution paths.

## Branch And GitHub Hygiene

- Development is trunk-based: short-lived branches cut from latest `main`,
  merged back via PR. No separate integration branch.
- **Merge only into `main`. Do not stack branches.** Every branch is cut from
  the current `main` tip and every PR bases on `main` — never open a PR whose
  base is another feature branch, and never build one branch on another's
  unmerged work. Multiple agents run here in parallel: a stacked branch breaks
  the moment the branch below it merges (its commits are rewritten onto `main`,
  leaving the upper branch dirty and its PR full of already-merged diffs). If
  your work genuinely depends on an unmerged change, wait for that PR to merge,
  then branch from the updated `main`.
- Check `git status` before changing anything; preserve unrelated user work.
- Open PRs with explicit closing references (`Closes #N`) when the PR completes
  an issue — the close-linked-issues workflow parses the merged PR body.
- Review/issue feedback gets a visible reply before the thread is resolved:
  what commit fixed it, why no action was needed, or what linked follow-up owns
  it. Never resolve threads silently.
- If a push seems to not trigger CI, or a PR shows a stale failing check: check
  `gh pr view <n> --json mergeable` FIRST — GitHub creates no workflow runs for
  a CONFLICTING PR. Merge `main` into the branch (`git merge origin/main`),
  resolve, then push.
- **Anything that must start another workflow run authenticates as
  `chores-dumb[bot]`** (branch/tag pushes, bot-opened PRs, `gh workflow run`) —
  a GitHub App whose installation token is minted per run from
  `CHORES_DUMB_CLIENT_ID` / `CHORES_DUMB_PRIVATE_KEY` by
  `actions/create-github-app-token`. `RELEASE_TOKEN` remains only as a fallback
  where the App is not installed. A bot, not a human PAT: a PAT opens the
  version PR as `qwts`, who cannot approve their own PR, so every release cut
  needed a ruleset bypass. Repo chores get a bot identity; agents get their own
  Apps, and the two never share one.
  Repository credentials must be absent while third-party tools run: checkouts
  that precede them use `persist-credentials: false`, and tokens are injected
  only into first-party steps containing the `git` / `gh` commands that need
  them.
  `GITHUB_TOKEN` events trigger no downstream workflows, and the repository's
  Actions policy authorizes actors explicitly — `github-actions[bot]` is not one
  of them, so its runs die at startup with "Actor is not allowed to trigger
  Actions workflows". **The PAT may reach only `actions/*` steps and our own
  `run:` blocks — never a third-party action**, whose future versions nobody
  here controls. When a third-party action is the only thing standing between
  the PAT and the run you need, replace it or drop it: versioning is a script in
  `version-cut.yml` rather than `changesets/action` for exactly this reason, and
  the E2E-report Pages publish was deleted rather than handed the token.

## Documentation And Validation

- Repo-first: long-lived docs, SOPs, ADRs, and agent pitfalls live in
  [`docs/`](docs/README.md) — ADRs in [`docs/adr/`](docs/adr/), acceptance and
  manual test plans in [`docs/acceptance/`](docs/acceptance/), user stories in
  [`docs/stories/`](docs/stories/) (see the
  [Repo Documentation Pointer Map](docs/Repo-Documentation-Pointer-Map.md)).
  The GitHub wiki is retired: its pages are stubs pointing here, kept only so
  existing links resolve. Never add content there — it is not indexed by code
  search, cannot be reviewed in a PR, and agents working from a clone never see
  it (see
  [ENG-0003](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0003-repo-is-documentation-source-of-truth.md)).
- **ADR gate:** an issue labeled `adr` changes an architectural contract — do
  not start its implementation until the governing ADR in
  [`docs/adr/`](docs/adr/) reads `Status: Accepted`
  (precedent: ADR-0022 ↔ #483, ADR-0023 ↔ #534). The issue's "ADR gate"
  section names the cluster: clustered issues share one ADR, written by
  whoever starts the first of them at the next free number, indexed, and
  linked from every clustered issue. Semantic changes after acceptance go
  through an ADR amendment first, code second.
- Before claiming done: run `npm run ci` (lint chain → format:check →
  `docs:gov` → test:cov → build — the same non-browser gates CI enforces,
  including the `.c8rc.json` coverage floor and the happy-dom renderer lane in
  `tests/dom`). Use `npm run test:dom` for a focused renderer DOM check. For
  E2E-relevant changes also run `npm run test:e2e`; for renderer/story-relevant
  changes also run `npm run test:stories:ci` (Storybook interaction tests — CI
  runs them in the core job). Do not report a build you did not run.
- **Documentation-governance gate** (`docs:gov`, part of the `npm run ci` chain;
  [ENG-0009](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0009-documentation-governance-gate.md)):
  the deterministic docs-gov check gates `docs/` and the root agent files against
  link/orphan/stale-path/heading/token-budget/anti-pattern rules per
  `docs-gov.config.json`. Its check implementation is **not** vendored — it lives
  once in `qwts/playbook-engineering` and both halves run it at the `v1` tag: CI
  via the reusable workflow `qwts/playbook-engineering/.github/workflows/docs-governance.yml@v1`
  (the required `Docs governance / docs-gov` status context), and locally via
  `scripts/check-docs-gov.mjs`, which needs `DOCS_GOV_TOOLING_ROOT` pointing at a
  `qwts/playbook-engineering` checkout with `tools/docs-gov` at the `v1` tag (the
  same env-gated external-checkout shape as `check:interop-acceptance` /
  `INTEROP_IMAGE_TRAIL_ROOT`). A governance finding fails `npm run ci` before it
  can fail CI. Raising a token budget always records a `reason` in the config.
- **Never push a fix for a red check without running that same check locally
  first.** CI is a verifier, not a test runner. A deterministic gate (lint,
  format, unit, coverage, build) that fails in CI means the push skipped local
  validation — run the failing gate locally until green, then push once.
  Iterating in CI burns a full runner cycle per guess and notifies the owner
  on every failure. (E2E under Xvfb is the one lane that can legitimately
  disagree with a local pass; say so on the PR when claiming that.)
- **Never bypass the Husky pre-push hook with `--no-verify`.** It runs the exact
  `npm run lint` entrypoint used by the hosted lint job, including both 800-line
  file-size tripwires. Fix the local failure before pushing.
- The macOS package job also loads the native HEIC decoder from the packaged
  app and decodes the checked-in iPhone fixture. Keep
  `scripts/verify-macos-heic-preview.mjs` and its readiness marker current when
  changing the native bridge, package layout, Electron ABI, or HEIC fixtures.
- Floors are ratchets — c8 (lines 90 / branches 80), type-coverage (99.8), the
  800-line file budget, the a11y violation budget (`tests/a11y/violation-budget.json`):
  raise them as coverage improves; never lower them to pass. The a11y budget
  ratchets the other way — its counts only **shrink**, and a surface that comes
  in under budget fails until the number is tightened. See
  [Testing Strategy](docs/Testing-Strategy.md)
  and [ADR-0001](docs/adr/ADR-0001-Automation-Check-Governance.md).
- **A11y runs in three lanes, and none of them subsumes the others.** `jsx-a11y`
  (strict, `src/renderer`) reads the **source**, so pointer-only handlers and
  label/control mismatches fail at authoring time; the **story** lane runs axe
  over every story; the **E2E** lane runs axe over composed flows plus the
  focus-obscured probe for SC 2.4.11, which has no axe rule. A story-lane pass
  proves nothing about composition, and an axe pass proves nothing about
  criteria axe does not implement — roughly two thirds of WCAG. The
  [Accessibility Audit](docs/Accessibility-Audit-2026-07.md)
  records which criteria are gated and which rest on the manual pass.
- **Never suppress an a11y rule bare.** `reportUnusedDisableDirectives` is
  `error`, so every `eslint-disable` must carry a reason: either why the code is
  verified correct, or the issue that owns the debt. When the fix lands the
  directive stops matching and the build fails until it is deleted — that is the
  ratchet, applied to exemptions. A blanket `rules: {'jsx-a11y/x': 'off'}` in a
  PR needs the same justification as lowering a coverage floor.
- **License-policy gate** (`lint:licenses`, part of the `lint` chain in
  `npm run ci`): `scripts/check-licenses.mjs` audits the _shipped_ dependency
  closure (production deps of `dependencies`/`optionalDependencies` plus the
  bundled `electron` runtime — see `scripts/dependency-closure.mjs`, not
  `devDependencies`) against the SPDX allowlist in `.license-policy.json`, and
  the same step verifies `THIRD-PARTY-NOTICES.md` is not stale. A new/upgraded
  dependency with a non-allowlisted or undeclared license fails CI until it is
  allowlisted or given a reviewed `exceptions` entry with a reason; then run
  `npm run licenses:notices` to refresh attributions. A CycloneDX SBOM
  (`npm run licenses:sbom`) is emitted into `release/` by the `package*` scripts.
- Dependencies use **exact pins**; Dependabot is the only actor that bumps
  versions. A set of **toolchain caps** holds back majors that would break the
  build: TypeScript stays **below 6.1.0** (typescript-eslint's peer cap),
  `@types/node` tracks the `.nvmrc` runtime major, Electron stays on the
  prebuilt-ABI major, and Vite / `@vitejs/plugin-react` / React are held until
  `electron-vite` supports Vite 8 and React 19 is migrated deliberately. Each is
  a Dependabot ignore; `.github/dependabot.yml` is the source of truth for the
  exact bounds and removal conditions.
- **`axe-core` is pinned exact and overridden into `axe-playwright`** (which
  depends on a floating `^4.10.1`). Its rule set _defines_ the a11y
  violation-budget counts, so an unpinned bump would move every number with no
  diff naming the cause. A Dependabot bump of it is _expected_ to move counts:
  re-audit and re-baseline in that PR
  (`OVERLOOK_A11Y_REPORT=<path> npm run test:stories:ci`), never widen the tags
  or raise a budget to make it pass.
- **`eslint-plugin-jsx-a11y` is overridden onto `$eslint`.** Its latest release
  (6.10.2) caps its peer at ESLint 9 and this repo is on 10, so npm refuses the
  install without the override. The rules were verified to actually run under
  ESLint 10 — this is a stale peer range, not an incompatibility. Revisit when
  upstream ships ESLint 10 support; if a bump ever breaks rule execution the
  symptom is jsx-a11y silently reporting **nothing**, so treat a sudden drop to
  zero findings as a failure, not a win.
- **`shell-quote` is overridden to 1.9.0** because `concurrently` 10.0.3 pins
  vulnerable 1.8.4 (CVE-2026-13311). Remove the override when `concurrently`
  adopts `shell-quote` 1.9.0 or later, after its Storybook orchestration lane
  passes without the override.
- **`uuid` is overridden to 11.1.1** because `@storybook/test-runner` 0.24.4
  resolves vulnerable 8.3.2 through its direct dependency, `jest-junit`, and
  `nyc` (CVE-2026-41907). Remove the override when the Storybook testing stack
  resolves only versions not affected by CVE-2026-41907, the interaction/report
  lane passes without the override, and the security scan remains clean.
- Behavior-changing PRs include a changeset (`npx changeset`); docs/tooling-only
  PRs may skip it. 0.x semantics (minor = behavior-changing, patch = fixes):
  [ADR-0002 Versioning Policy](docs/adr/ADR-0002-Versioning-Policy.md).
  `CHANGELOG.md` is generated by `npm run changeset:version` — never hand-edit.
- Releases are cut by merging the bot-maintained **Version packages** PR (the
  version-cut workflow keeps it current while changesets are pending). That
  merge is tagged `v0.x.y` automatically and the Release workflow publishes
  mac + win builds, CHANGELOG notes, and the design-package zip. Windows ships
  two architecture-qualified NSIS installers — `overlook-windows-x64` and
  `overlook-windows-arm64` (arm64 cross-compiled on the x64 runner) — each
  gated post-build by `verify-windows-arch.mjs`, which fails the leg if any
  payload (`Overlook.exe` or a shipped `*.node`) is not the target PE machine
  type (#683). Signing is env-gated on repo secrets (#128, #683): `CSC_LINK`
  plus `APPLE_API_KEY` signs + notarizes the mac build; `AZURE_TENANT_ID` /
  `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` drive Azure Trusted Signing for the
  Windows installers (verified with `signtool`; see
  [`SIGNING.md`](SIGNING.md)); restricted Touch ID identity entitlements are
  included only when `MAC_PROVISIONING_PROFILE` is also present and
  validated. Every tag publishes as a GitHub prerelease regardless of signing
  availability. Each clickable mac
  and Windows installer asset is labeled `signed` or `unsigned` from its own
  platform gate; signing state never changes the release title or prerelease
  status. The macOS release gate extracts the generated ZIP and launches it in
  an isolated smoke mode. Never hand-tag releases or invoke Changesets
  versioning directly.

## Process-Tree Guard

- Every test entrypoint (`npm test`, `test:dom`, `test:cov`, `test:stories*`,
  `test:e2e*`, `test:perf`) runs through `scripts/run-guarded.mjs`: an
  aggregate RSS ceiling over the whole descendant tree, a per-process Node
  heap cap, a wall-clock timeout, and one guarded run at a time per worktree.
- Never invoke `electron --test`, `node --test`, `.test-dist`/`.test-dist-dom`
  output, `playwright test`, `test-storybook`, or `c8` directly, and never call
  `:run`/`:inner` npm scripts — use the guarded entrypoints. Claude Code and
  Cursor deny these mechanically via checked-in hooks; Codex and raw terminals
  rely on this rule.
- If a command returns while still running (live session/cell), poll or
  terminate it before launching anything else. The guard refuses a second run
  in the same worktree ("another guarded run is active") — treat that as a
  stop, not a prompt to retry.
- A run killed for `rss-limit`/`timeout` is a real failure: read
  `.guard/last-run.json`, report it, and do not rerun with a higher limit to
  make it pass. Knobs and details: `docs/agent-process-guard.md`.

## Tooling

- Node is pinned in `.nvmrc`; select it (`nvm use`) before installing. CI reads
  the same file — bump it to move local and CI together.
- Install with `npm ci`; it also installs the husky pre-commit hook
  (lint-staged: `eslint --fix` + prettier on staged files). Fix what it flags;
  `git commit --no-verify` is for emergencies.
- The `/check` command (`.claude/commands/check.md`) wraps the full gate run.
- Invoke tools through `PATH` (or `npx`); never hardcode machine-specific paths.
- Local macOS `test:e2e` windows stay hidden and must never activate or take
  desktop focus, including through `second-instance`, `open-file`, or Dock
  activation. Route every native restore/show/focus path through
  `e2e-window-visibility.ts`; use `test:e2e:visible` only for deliberate manual
  debugging.
