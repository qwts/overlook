import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const codeql = readFileSync(join(root, '.github/workflows/codeql.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const versionCut = readFileSync(join(root, '.github/workflows/version-cut.yml'), 'utf8');

describe('governed CI lifecycle (ENG-0004)', () => {
  test('uses only governed CI triggers and PR-scoped cancellation', () => {
    assert.match(ci, /^ {2}pull_request:$/mu);
    assert.match(ci, /types: \[opened, synchronize, reopened, ready_for_review\]/u);
    assert.match(ci, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/mu);
    assert.match(ci, /^ {2}push:\n {4}branches: \[main\]$/mu);
    assert.match(ci, /^ {2}workflow_dispatch:$/mu);
    assert.doesNotMatch(ci, /^ {2}(?:pull_request_target|repository_dispatch|schedule):$/mu);
    assert.match(ci, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/u);
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/u);
  });

  test('loads actor and fork enforcement from the reviewed immutable policy commit', () => {
    assert.match(ci, /uses: qwts\/playbook-engineering\/\.github\/actions\/ci-policy@012ec7b8cd101c528b587d969e8d21da4e589770/u);
    assert.doesNotMatch(ci, /uses: \.\/\.github\/actions\/ci-policy/u);
    assert.match(ci, /github\.event\.pull_request\.draft == false/u);
  });

  test('reuses only exact-SHA complete-suite evidence', () => {
    assert.match(ci, /event=workflow_dispatch&head_sha=\$TARGET_SHA/u);
    assert.match(ci, /event=merge_group&head_sha=\$GITHUB_SHA/u);
    assert.match(ci, /\.path == "\.github\/workflows\/ci\.yml"/u);
    assert.match(ci, /\.name == "CI" and \.conclusion == "success"/u);
    assert.match(ci, /needs\.preflight-evidence\.outputs\.validated != 'true'/u);
    assert.match(ci, /needs\.merge-evidence\.outputs\.validated != 'true'/u);
  });

  test('retains every agreed complete-suite command and stable gate', () => {
    for (const command of [
      'npm ci',
      'npm run check:interop-acceptance',
      'npm run lint',
      'npm run format:check',
      'npm run check:changesets',
      'npm run check:acceptance-coverage',
      'npm run check:a11y-budget',
      'npm run test:cov',
      'npm run build',
      'npm run test:stories:ci',
      'npm run test:e2e',
    ]) {
      assert.match(ci, new RegExp(command, 'u'));
    }
    assert.match(ci, /name: Docs governance/u);
    assert.match(ci, /^ {2}e2e-gate:\n {4}name: E2E gate$/mu);
    assert.match(ci, /^ {2}gate:\n {4}name: CI$/mu);
  });

  test('runs advanced CodeQL for both existing languages through CI only', () => {
    assert.match(codeql, /^ {2}workflow_call:$/mu);
    assert.doesNotMatch(codeql, /^ {2}(?:pull_request|push|workflow_dispatch|schedule):$/mu);
    assert.match(codeql, /language: \[actions, javascript-typescript\]/u);
    assert.match(codeql, /security-events: write/u);
    assert.match(codeql, /github\/codeql-action\/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38/u);
    assert.match(codeql, /github\/codeql-action\/analyze@f205ea1c3313d32999d8d6a48b4f6530d4437b38/u);
  });

  test('keeps main on smoke-or-complete fallback while CodeQL owns default-branch alerts', () => {
    assert.match(ci, /name: Post-merge smoke/u);
    assert.match(ci, /name: Interop integration smoke/u);
    assert.match(ci, /needs\.policy\.outputs\.run_post_merge == 'true' \|\|/u);
    assert.match(ci, /if \[ "\$MERGE_VALIDATED" = true \]; then[\s\S]*test "\$POST_MERGE" = success[\s\S]*else/u);
  });

  test('release publication fails closed on exact complete-suite and reviewed-PR evidence', () => {
    assert.match(release, /name: Verify release evidence/u);
    assert.match(release, /event=merge_group&head_sha=\$RELEASE_SHA/u);
    assert.match(release, /event=push&head_sha=\$RELEASE_SHA/u);
    assert.match(release, /\.name == "Complete suite" and \.conclusion == "success"/u);
    assert.match(release, /\.state == "APPROVED"/u);
    assert.match(release, /event=pull_request&head_sha=\$pr_head/u);
    assert.match(release, /needs: \[verify, build\]/u);
  });

  test('versioning dispatches no duplicate CI and the native queue replaces branch rewriting', () => {
    assert.doesNotMatch(versionCut, /gh workflow run ci\.yml/u);
    assert.match(versionCut, /event=push&head_sha=\$GITHUB_SHA/u);
    assert.equal(existsSync(join(root, '.github/workflows/auto-update-prs.yml')), false);
  });
});
