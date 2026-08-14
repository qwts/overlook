---
description: Run the locally-runnable validation gates and report each result explicitly.
argument-hint: '[none]'
---

Run every validation gate that belongs on this machine and report every result.
When a gate fails, surface the failure verbatim, fix it when in scope, rerun it,
and continue through the remaining gates. If a fix edits any tracked file,
discard every earlier gate result and restart the sequence at `npm run lint`;
report success only after one complete, edit-free pass through all gates.

## 1. Run the gates (in order, one at a time)

```sh
npm run lint            # pins → new-file size → eslint → cycles → dead code → type coverage
npm run format:check
npm run check:a11y-budget  # a11y violation budget: shape, path existence, owned debt
npm run docs:gov        # documentation-governance gate (needs DOCS_GOV_TOOLING_ROOT; see AGENTS.md)
npm test                # typecheck + compile + unit/DOM suites + guard conformance
```

**Do not run `test:cov`, `build`, `test:e2e`, `test:stories:ci` or `npm run ci`
here.** Those are CI-owned lanes: they are what exhausted the owner's machine
(ENG-0138), the memory guard denies them to agents, and CI is the authoritative
lane for them regardless of what ran locally. Push and let CI verify them.

## 2. Report

State, explicitly:

- ✅/❌ per gate (lint, format:check, check:a11y-budget, docs:gov, test), with
  the failing output if any.
- That `test:cov`, `build`, `test:e2e` and `test:stories:ci` were deferred to CI
  — as deferred, never as passing. Link the CI run once it has one.
- The a11y violation budget total, and whether any surface came in **under**
  budget (which fails, and is fixed by tightening the entry — never by raising
  it).
- The `AGENTS.md` status footer (Build / Commit), because `/check`
  is a validation run.

No product-invariant checks exist yet — when `AGENTS.md` → Product Invariants
gains entries backed by executable tests, call each out here by name.
