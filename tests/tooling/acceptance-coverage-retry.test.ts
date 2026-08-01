import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('acceptance coverage retries transient GitHub API failures (#357)', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/check-acceptance-coverage-diff.mjs'), 'utf8');
  assert.match(source, /const GH_ATTEMPTS = 3/u);
  assert.match(source, /attempt === GH_ATTEMPTS/u);
  assert.match(source, /await new Promise/u);
  assert.match(source, /await gh\(\['api'/u);
  assert.match(source, /git', \['diff', '--name-only'/u);
  assert.match(source, /signed pull-request event snapshot/u);
});

test('manual exact-SHA CI resolves PR metadata for acceptance opt-outs', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/check-acceptance-coverage-diff.mjs'), 'utf8');
  assert.match(source, /GITHUB_EVENT_NAME.*===.*'workflow_dispatch'/u);
  assert.match(source, /pulls\?state=open&head=/u);
  assert.match(source, /\.\.\.HEAD/u);
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/u);
  assert.match(workflow, /exact-sha-preflight/u);
});

// Replaces the two E2E-report guards (#357 freshness via git ls-remote, #715
// fork head refs passed as env data rather than shell source). The job they
// guarded is gone: publishing ended in GitHub's managed "pages build and
// deployment" run, which is triggered by github-actions[bot] and refused by this
// repository's Actions actor policy, and the only repair would have handed a
// repo-scoped PAT to a third-party publishing action. If per-PR report hosting
// ever returns, it needs both of those hardenings again — and a publisher that
// does not require the PAT.
test('the E2E report ships as a run artifact only, with no Pages publishing path (#357, #715)', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /name: playwright-report/u);
  assert.doesNotMatch(workflow, /e2e-report/u);
  assert.doesNotMatch(workflow, /gh-pages/u);
  assert.doesNotMatch(workflow, /peaceiris/u);
});
