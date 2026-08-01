# ADR-0001: Automation Check Governance

## Status

Accepted

## Context

photos was bootstrapped (epic [#1](https://github.com/qwts/photos/issues/1))
with the CI/CD, static-analysis, and SDLC automation proven in
[image-trail](https://github.com/qwts/image-trail), so that every PR to `main`
passes the full gate suite from day one. The project needs one canonical place
to track why each check exists, how its floors move, and how bypasses are
compensated.

This ADR covers repository automation and merge gates, not product features.

## Decision

Automation-check decisions are tracked in ADRs whenever they affect merge
requirements, CI behavior, security review, ownership, or the expected local
verification flow. Every PR completes a documentation review before merge: if
the change alters behavior, architecture, testing strategy, or CI expectations,
the relevant wiki page updates in the same unit of work; otherwise the PR says
why not.

## The gate suite

| Check                        | Command / mechanism                                                                                                                                                                                                           | Protected use case                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact dependency pins        | `lint:package` (`scripts/check-package-pins.mjs`)                                                                                                                                                                             | Dependabot is the only actor that bumps versions; every bump is a reviewable diff. Ranges and tags fail.                                                                                                                                                                                                                                                         |
| File-size budget (new files) | `lint:new-files` (`scripts/check-new-file-size.mjs`)                                                                                                                                                                          | New/staged/untracked files stay under 800 physical lines.                                                                                                                                                                                                                                                                                                        |
| File-size budget (growth)    | ESLint `max-lines` **error** (800, skips blanks/comments)                                                                                                                                                                     | **Existing** files cannot grow past the budget — no legacy exemptions.                                                                                                                                                                                                                                                                                           |
| Correctness lint             | `eslint .` — typescript-eslint recommended-type-checked, type-aware via `projectService`; renderer adds react-hooks + `@eslint-react`; `no-restricted-imports` enforces the process-boundary matrix (CLAUDE.md §Architecture) | Unsafe TS, floating promises, unused code, hook misuse, cross-process imports. Prettier owns style; ESLint owns correctness.                                                                                                                                                                                                                                     |
| Circular imports             | `lint:cycles` (`madge --circular --extensions ts,tsx`)                                                                                                                                                                        | Zero import cycles in `src/`.                                                                                                                                                                                                                                                                                                                                    |
| Dead code                    | `lint:dead` (`knip`)                                                                                                                                                                                                          | No unused files, exports, or dependencies.                                                                                                                                                                                                                                                                                                                       |
| Type coverage                | `lint:types` (`type-coverage --at-least 99.8 --strict`, run per TS project: root, main, preload, renderer)                                                                                                                    | `any` regressions in every process.                                                                                                                                                                                                                                                                                                                              |
| Formatting                   | `format:check` (Prettier)                                                                                                                                                                                                     | No formatting churn in review.                                                                                                                                                                                                                                                                                                                                   |
| Unit tests + coverage floor  | `test:cov` (node:test + c8; floors **lines 90 / branches 80**)                                                                                                                                                                | Behavior regressions; floors ratchet upward only.                                                                                                                                                                                                                                                                                                                |
| Build                        | `build` (`electron-vite build` → `out/` main/preload/renderer bundles)                                                                                                                                                        | The app compiles and bundles.                                                                                                                                                                                                                                                                                                                                    |
| E2E                          | `test:e2e` (Playwright `_electron` drives the built app in the complete-suite lane under xvfb)                                                                                                                                | The real app launches, renders, and its typed IPC works end to end.                                                                                                                                                                                                                                                                                              |
| Storybook interaction tests  | `test:stories:ci` (static build + test-runner `play` assertions, chromium, in the core CI job)                                                                                                                                | Component-level UI behavior regressions.                                                                                                                                                                                                                                                                                                                         |
| A11y violation budget        | `check:a11y-budget` (`scripts/check-a11y-budget.mjs`, in `npm run ci`) + axe in `test:stories:ci` (per story) and `test:e2e` (composed flows)                                                                                 | WCAG 2.2 AA regressions (#398, epic #381). Budget is a **shrink-only** ratchet, keyed by axe rule id (a bare total would let one rule swap for another and hide a regression); unlisted surfaces are budgeted at zero; under-budget and orphaned entries fail too. `axe-core` pinned exact + overridden into `axe-playwright` — its rule set defines the counts. |
| `E2E gate`                   | Stable complete-suite E2E verdict                                                                                                                                                                                             | Required-check stability across ready, manual, queue, and main-fallback runs.                                                                                                                                                                                                                                                                                    |
| CodeQL                       | Advanced setup: `javascript-typescript` + `actions`, invoked by governed CI                                                                                                                                                   | Security findings block above threshold while actor policy remains enforceable.                                                                                                                                                                                                                                                                                  |
| CODEOWNERS                   | `.github/CODEOWNERS` → repo owner                                                                                                                                                                                             | Governance files stay owner-reviewed once the ruleset requires it.                                                                                                                                                                                                                                                                                               |
| Pre-commit hook              | husky + lint-staged (`eslint --fix` + prettier on staged files)                                                                                                                                                               | Staged-file hygiene at commit time.                                                                                                                                                                                                                                                                                                                              |
| Pre-push hook                | husky (`npm run lint`, identical to the hosted lint entrypoint)                                                                                                                                                               | Blocks pushes that violate package, file-size, color, contrast, correctness, cycle, dead-code, type-coverage, i18n, or license policy; must not be bypassed with `--no-verify`.                                                                                                                                                                                  |
| Close-linked issues          | Workflow on merged PRs to `main`                                                                                                                                                                                              | Issue lifecycle even on admin-bypass merges; PR bodies carry `Closes #N`.                                                                                                                                                                                                                                                                                        |
| Dependabot                   | Weekly grouped npm + actions PRs                                                                                                                                                                                              | Updates flow through CI like any PR; no auto-merge.                                                                                                                                                                                                                                                                                                              |

## Floor and version-line policy

- **Floors ratchet upward only:** c8 lines/branches, type-coverage, and the
  800-line file budget are never lowered to make a change pass.
- **The a11y violation budget ratchets downward only** (#398): its counts are the
  audited baseline and only ever shrink. A surface coming in _under_ budget fails
  until the entry is tightened or deleted — an unbanked win is a silent licence to
  regress. Narrowing the audited WCAG tag set is the same offence as raising a floor.
- **Version lines are pinned deliberately:** TypeScript stays on the 6.x line
  while typescript-eslint's peer range caps at `<6.1.0`; `@types/node` tracks
  the runtime major in `.nvmrc` (Node 24). Both are enforced as Dependabot
  `ignore` rules with documented removal conditions; `overrides` pin madge's
  and type-coverage's TypeScript to the project compiler.

## Bypass policy and compensation

- A main commit without successful exact merge-group evidence runs the complete
  suite. The close-linked-issues workflow still compensates for bypassed native
  issue closure.
- A bypass of a red gate must leave an audit trail: the reason on the PR, and a
  follow-up issue if the red state survives the merge.
- Review threads are never silently ignored: fixed (commit named), deferred
  (issue linked), or rejected (rationale posted) — then resolved.

## Consequences

- PRs stay small; adjacent concerns become linked issues, not scope growth.
- Automation debt is recorded (deferred lanes: DOM tests, Storybook (#11),
  acceptance coverage-map), never invisible.
- The branch ruleset requires stable `CI`, `E2E gate`,
  `Docs governance / docs-gov`, and the CodeQL code-scanning context — never
  transient implementation jobs.

## Follow-up decisions to track

- Adopting the acceptance coverage-map ledger once user-facing surfaces exist.
- Whether Storybook interaction tests (#11) fold into the core CI job or run
  as their own lane.
- Versioning policy + changesets (issue #18) — likely ADR-0002.
