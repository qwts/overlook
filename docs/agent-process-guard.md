# Agent memory guard — overlook baselines

The guard itself is governance-owned and shared across repos. Its budget
formula, admission rules, lane policy, owner grants, environment variables and
refusal handling are documented once, in
[machine memory guard](https://github.com/qwts/playbook-engineering/blob/master/docs/reference/agent-memory-guard.md)
(decision record:
[ENG-0138](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0138-machine-scoped-agent-memory-budget.md)).
Read that page for anything about how the guard behaves.

The tooling arrives here by harness sync as `tools/agent-guard/`. **Never edit
it in this repo** — a local edit is overwritten by the next sync and breaks the
machine-wide protocol the copies coordinate on. Fixes go to
`qwts/playbook-engineering`. `tools/agent-guard/tests/conformance.test.mjs` runs
as part of `npm test` here and fails if the hook wiring is ever dropped, which
is how `e1d86f6a` silently disarmed the previous guard.

The agent-facing rules are in [`AGENTS.md`](../AGENTS.md) → **Memory Guard**.
This page carries only what is specific to overlook: what its lanes actually
cost, and one platform caveat that changes how those numbers read.

## Measured per-lane RSS

Ceilings are no longer per-lane constants — they derive from the machine and are
clamped to it. These peaks are kept because they are still the evidence for
which lanes are heavy, how much a lane's cost varies run to run, and whether a
kill was a real regression or a lane that has always sat near the line. Current
numbers for a working checkout are in `.guard/history.jsonl`.

- **`npm test`** (typecheck + compile + Electron-hosted unit + happy-dom DOM):
  peak 1845–2071 MB across 19 processes locally (macOS, Apple Silicon, Node
  24.18) over three runs.
- **`npm run test:cov`** (the same suite under `c8`): peak 1932 MB across 20
  processes locally; 1194–1198 MB across 13 processes on CI (Linux).
- **`npm run test:stories:ci`** (static Storybook build served over http, driven
  by Playwright chromium): **8067 MB** local peak on one run and **5660 MB** on
  another — a >2× spread across runs of the same lane, with the esbuild/webpack
  build step, not the interaction tests, as the heavy part. CI's first real run
  peaked at 3849 MB across 24 processes. This lane is the reason a single
  measured peak is not a safe ceiling.
- **`npm run test:e2e`** (Playwright driving real Electron instances,
  `workers: 3` on CI): CI peak 4183 MB across 24 processes. Never measured
  locally — the lane pops real Electron windows and is CI-only in practice.
- **`npm run test:perf`** (single worker, 200K-photo synthetic seed): still
  unmeasured, and not measurable from CI — `perf.yml` invokes `test:perf:inner`
  directly on a runner, so the guard never runs there and writes no record. A
  baseline for this lane needs an owner-granted local run.

## macOS and Linux do not agree

`ps` reports meaningfully different aggregate RSS for the same lane on the two
platforms, with macOS consistently higher — `test:stories:ci` above is the
clearest case (8067 MB local vs 3849 MB on CI for the same work). So:

- A local (macOS) peak and a CI (Linux) peak for the same lane are not
  comparable, and a lane that fits comfortably in CI can still exhaust a local
  machine. CI passing is not evidence that a lane is safe to run locally.
- The guard's own limits are derived from the machine it runs on, so this gap no
  longer has to be hand-compensated in a ceiling — but it does still change how
  the numbers above should be read.
