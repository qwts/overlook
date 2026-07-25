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

test('dispatched CI resolves PR metadata so the acceptance opt-out survives auto-rebases (PR #541 review)', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/check-acceptance-coverage-diff.mjs'), 'utf8');
  assert.match(source, /GITHUB_EVENT_NAME.*===.*'workflow_dispatch'/u);
  assert.match(source, /pulls\?state=open&head=/u);
  assert.match(source, /\.\.\.HEAD/u);
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/auto-update-prs.yml'), 'utf8');
  assert.match(workflow, /types: \[opened, reopened, ready_for_review\]/u);
  assert.match(workflow, /--force-with-lease/u);
});

test('E2E report freshness does not depend on the pull-request metadata API (#357)', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /git ls-remote/u);
  assert.doesNotMatch(workflow, /current=\$\(gh api/u);
});

test('E2E report freshness treats fork head refs as data, not shell source (#715)', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const freshnessStep = workflow.match(/- name: Check this run is for the PR's current head\n(?<step>.*?)(?=\n {6}- name: Deploy report)/su)
    ?.groups?.['step'];

  assert.ok(freshnessStep);
  assert.match(freshnessStep, /HEAD_REF: \$\{\{ github\.head_ref \}\}/u);
  assert.match(freshnessStep, /"refs\/heads\/\$HEAD_REF"/u);
  assert.doesNotMatch(freshnessStep, /run:[\s\S]*\$\{\{ github\.head_ref \}\}/u);
});
