# Agent memory budget — overlook baselines

The machine memory guard that once wrapped every test entrypoint
(`tools/agent-guard/`) was removed in `e4bc20c6`; nothing enforces a budget
locally now. These measurements are kept because they are still the evidence
for which lanes are heavy and why they belong to CI. The agent-facing rule is in
[`AGENTS.md`](../AGENTS.md) → **Memory Budget**.

## Measured per-lane RSS

These peaks show which lanes are heavy and how much a lane's cost varies run to
run.

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
  directly on a runner and records no peak. A baseline for this lane needs an
  owner-approved local run.

## macOS and Linux do not agree

`ps` reports meaningfully different aggregate RSS for the same lane on the two
platforms, with macOS consistently higher — `test:stories:ci` above is the
clearest case (8067 MB local vs 3849 MB on CI for the same work). So:

- A local (macOS) peak and a CI (Linux) peak for the same lane are not
  comparable, and a lane that fits comfortably in CI can still exhaust a local
  machine. CI passing is not evidence that a lane is safe to run locally.
- Read the numbers above with that gap in mind.
