---
'overlook': patch
---

test: run every test lane, then fail once

`test:run` chained the unit, renderer DOM, and guard-conformance lanes with
`&&`, so the first red lane skipped the rest. Under `test:cov` that also
distorted coverage: the DOM lane covers the renderer files `.c8rc.json` admits,
and a lane that never runs reports them at 0%, which is enough to breach the
line floor on its own. The lanes now run through `scripts/run-test-lanes.mjs`,
which runs all of them, names every failure, and keeps the non-zero exit CI
reads.
