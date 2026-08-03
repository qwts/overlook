import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();
const autoUpdate = readFileSync(join(root, '.github/workflows/auto-update-prs.yml'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const codeql = readFileSync(join(root, '.github/workflows/codeql.yml'), 'utf8');
const closeLinkedIssues = readFileSync(join(root, '.github/workflows/close-linked-issues.yml'), 'utf8');
const packageWorkflow = readFileSync(join(root, '.github/workflows/package.yml'), 'utf8');
const perf = readFileSync(join(root, '.github/workflows/perf.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const versionCut = readFileSync(join(root, '.github/workflows/version-cut.yml'), 'utf8');
const identityPolicy = readFileSync(join(root, 'docs/CI-Identity-And-Tokens.md'), 'utf8');

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
    assert.match(ci, /uses: qwts\/playbook-engineering\/\.github\/actions\/ci-policy@c7d95401590a7d38bc90f5b51df66edcc4104528/u);
    assert.doesNotMatch(ci, /uses: \.\/\.github\/actions\/ci-policy/u);
    assert.match(ci, /github\.event\.pull_request\.draft == false/u);
  });

  test('documents the narrow native-queue exception and disabled preview policy', () => {
    assert.match(identityPolicy, /both actor fields to be `github-merge-queue\[bot\]`/u);
    assert.match(identityPolicy, /Workflow execution protections\*\* disabled/u);
    assert.match(identityPolicy, /never approve\s+public-fork runs/u);
    assert.match(identityPolicy, /Bind\s+`CodeQL` to the GitHub Advanced Security App/u);
    assert.match(identityPolicy, /other three contexts\s+to GitHub Actions — never to `chores-dumb`/u);
    assert.match(identityPolicy, /only its stable `E2E gate` verdict belongs in branch protection/u);
  });

  test('authorizes every direct non-CI entrypoint before repository work', () => {
    const workflows = [autoUpdate, packageWorkflow, perf, release, versionCut, closeLinkedIssues];
    for (const workflow of workflows) {
      assert.match(workflow, /^ {2}policy:$/mu);
      assert.match(workflow, /authorization-only: 'true'/u);
      assert.match(workflow, /ci-policy@c7d95401590a7d38bc90f5b51df66edcc4104528/u);
    }
    for (const [workflow, jobs] of [
      [autoUpdate, ['update']],
      [packageWorkflow, ['package']],
      [perf, ['perf']],
      [release, ['verify']],
      [versionCut, ['version-pr']],
      [closeLinkedIssues, ['close-linked-issues']],
    ] as const) {
      for (const job of jobs) assert.match(workflow, new RegExp(`^  ${job}:\\n {4}needs: policy`, 'mu'));
    }
    assert.match(versionCut, /^ {2}tag:\n {4}needs: \[policy, version-pr\]$/mu);
  });

  test('reuses only exact-SHA complete-suite evidence', () => {
    assert.match(ci, /event=workflow_dispatch&head_sha=\$TARGET_SHA/u);
    assert.match(ci, /\.display_title == "CI workflow_dispatch purpose=exact-sha-preflight retries=0"/u);
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
    assert.match(ci, /git branch main origin\/main/u);
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

  test('versioning dispatches no duplicate CI and the governed updater preserves freshness', () => {
    assert.doesNotMatch(versionCut, /gh workflow run ci\.yml/u);
    assert.match(versionCut, /event=push&head_sha=\$GITHUB_SHA/u);
    assert.equal(existsSync(join(root, '.github/workflows/auto-update-prs.yml')), true);
    assert.match(autoUpdate, /name: Require chores-dumb credentials/u);
    assert.match(
      autoUpdate,
      /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID != '' && secrets\.CHORES_DUMB_PRIVATE_KEY != '' \}\}/u,
    );
    assert.match(autoUpdate, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
    assert.doesNotMatch(autoUpdate, /RELEASE_TOKEN|\|\| github\.token/u);
  });
});
