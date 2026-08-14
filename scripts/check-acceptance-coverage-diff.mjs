#!/usr/bin/env node

// Diff-aware forcing function for the acceptance coverage map (#82, ported
// from image-trail per ADR-0001). When a PR changes user-facing source — the
// .ts/.tsx/.css under src/renderer/src/ (styles drive visible states) — it
// must also touch tests/e2e/coverage-map.json, i.e. account for the change's
// acceptance impact by adding/updating an entry (automated, or
// manual/deferred with justification). Excluded as non-shipping: *.test.ts,
// *.stories.tsx, and type declarations. A change with genuinely no
// acceptance impact opts out with a `no-acceptance-impact` token in the PR
// body or a label of the same name.
//
// Intentionally strict: on an agent-driven repo a false positive is cheap
// (add the entry or the opt-out), while a silent coverage gap compounds.
// The body opt-out only counts as a CHECKED checkbox line containing the
// token — the PR template ships the token in its (unchecked) acceptance
// checkbox, so a bare substring match would bypass the gate on every PR
// (PR #169 review).
//
// Inputs come from the pull_request event + `gh` (live PR body/labels, so an
// edited opt-out is honored on a re-run). Outside that context (a local run,
// `npm run ci` before pushing) it falls back to a git diff against the
// merge-base with origin/main — catching the missing map update before the
// push. The local fallback has no PR body/labels, so the opt-out only works
// once a PR exists. Override via env for ad-hoc testing:
// ACCEPTANCE_CHECK_FILES (newline/comma list), ACCEPTANCE_CHECK_BODY,
// ACCEPTANCE_CHECK_LABELS (comma list).

import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const COVERAGE_MAP_PATH = 'tests/e2e/coverage-map.json';
const ACK_TOKEN = 'no-acceptance-impact';
// A checked task-list item mentioning the token: "- [x] ... no-acceptance-impact ...".
const ACK_CHECKBOX = /-\s*\[x\][^\n]*no-acceptance-impact/iu;
const ACCEPTANCE_SOURCE = /^src\/renderer\/src\/.*\.(ts|tsx|css)$/u;
const NON_FLOW = /(\.test\.tsx?|\.stories\.tsx?|\.d\.ts)$/u;
const GH_ATTEMPTS = 3;

function isAcceptanceSource(file) {
  return ACCEPTANCE_SOURCE.test(file) && !NON_FLOW.test(file);
}

/**
 * Pure decision: given the PR's changed files and opt-out signals, decide
 * whether the acceptance coverage map has been accounted for.
 */
export function evaluateAcceptanceCoverage({ changedFiles, body = '', labels = [] }) {
  const acceptanceFiles = changedFiles.filter(isAcceptanceSource);
  if (acceptanceFiles.length === 0) {
    return { ok: true, acceptanceFiles, reason: 'no acceptance-relevant source changed' };
  }
  if (changedFiles.includes(COVERAGE_MAP_PATH)) {
    return { ok: true, acceptanceFiles, reason: 'coverage-map.json updated alongside the change' };
  }
  const acknowledged = ACK_CHECKBOX.test(body) || labels.some((label) => label.toLowerCase() === ACK_TOKEN);
  if (acknowledged) {
    return { ok: true, acceptanceFiles, reason: `opted out via "${ACK_TOKEN}" (checked box or label)` };
  }
  return { ok: false, acceptanceFiles, reason: 'acceptance-relevant source changed with no coverage-map update or opt-out' };
}

function splitList(value) {
  return (value ?? '')
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function gh(args) {
  for (let attempt = 1; attempt <= GH_ATTEMPTS; attempt += 1) {
    try {
      return execFileSync('gh', args, { encoding: 'utf8' });
    } catch (error) {
      if (attempt === GH_ATTEMPTS) throw error;
      const delayMs = attempt * 1_000;
      console.warn(`GitHub API request failed (attempt ${attempt}/${GH_ATTEMPTS}); retrying in ${delayMs}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('GitHub API retry loop exhausted');
}

async function gatherInputs() {
  if (process.env.ACCEPTANCE_CHECK_FILES) {
    return {
      changedFiles: splitList(process.env.ACCEPTANCE_CHECK_FILES),
      body: process.env.ACCEPTANCE_CHECK_BODY ?? '',
      labels: splitList(process.env.ACCEPTANCE_CHECK_LABELS),
      context: 'local override',
    };
  }

  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const repo = process.env.GITHUB_REPOSITORY;
    const number = event.pull_request?.number ?? event.number;
    const base = event.pull_request?.base?.sha;
    if (typeof base !== 'string' || base === '') throw new Error('pull-request event has no base SHA');
    const changedFiles = splitList(execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }));
    let pr = event.pull_request;
    try {
      // Prefer live metadata so an edited opt-out is honored on a re-run.
      pr = JSON.parse(await gh(['api', `repos/${repo}/pulls/${number}`]));
    } catch {
      console.warn('GitHub API remained unavailable; using the signed pull-request event snapshot.');
    }
    return {
      changedFiles,
      body: pr.body ?? '',
      labels: (pr.labels ?? []).map((label) => label.name),
      context: `PR #${number}`,
    };
  }

  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REPOSITORY) {
    // Manual complete-suite runs may validate the exact head before a draft is
    // promoted. Resolve its PR so the reviewed acceptance opt-out still applies.
    // Resolve the branch's open PR live so the no-acceptance-impact opt-out keeps
    // working on auto-rebased heads (PR #541 review); a branch with no open PR —
    // or an API outage — falls through to the local diff, as before.
    const repo = process.env.GITHUB_REPOSITORY;
    const branch = (process.env.GITHUB_REF_NAME ?? '').trim();
    if (branch !== '') {
      try {
        const owner = repo.split('/')[0];
        const prs = JSON.parse(await gh(['api', `repos/${repo}/pulls?state=open&head=${owner}:${branch}`]));
        const pr = prs[0];
        if (pr) {
          // Three-dot (merge-base) diff: after an auto-rebase the PR base tip may
          // already contain commits this branch lacks; two-dot would blame them here.
          const changedFiles = splitList(execFileSync('git', ['diff', '--name-only', `${pr.base.sha}...HEAD`], { encoding: 'utf8' }));
          return {
            changedFiles,
            body: pr.body ?? '',
            labels: (pr.labels ?? []).map((label) => label.name),
            context: `PR #${pr.number} (dispatched)`,
          };
        }
      } catch {
        console.warn('Could not resolve an open PR for the dispatched branch; using the local diff.');
      }
    }
  }

  return gatherLocalDiffInputs();
}

function resolveBaseRef() {
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' });
      return ref;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Local fallback: diff committed changes against the merge-base with the
 * default branch so the check runs before a PR exists. Uncommitted changes
 * aren't included — commit first, same as the rest of the `ci` gate expects.
 */
function gatherLocalDiffInputs() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.log('No origin/main or main ref found; skipping local acceptance-coverage diff check.');
    return null;
  }
  let mergeBase;
  try {
    mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], { encoding: 'utf8' }).trim();
  } catch {
    console.log(`Could not compute a merge-base with ${baseRef}; skipping local acceptance-coverage diff check.`);
    return null;
  }
  const changedFiles = splitList(execFileSync('git', ['diff', '--name-only', `${mergeBase}...HEAD`], { encoding: 'utf8' }));
  return { changedFiles, body: '', labels: [], context: `local diff vs ${baseRef}` };
}

async function main() {
  const inputs = await gatherInputs();
  if (!inputs) {
    console.log('Could not determine changed files (no PR context, no git ref); skipping acceptance-coverage diff check.');
    return;
  }

  const result = evaluateAcceptanceCoverage(inputs);
  if (result.ok) {
    console.log(`Acceptance coverage OK (${inputs.context}): ${result.reason}.`);
    return;
  }

  console.error(`Acceptance coverage check failed (${inputs.context}).`);
  console.error('');
  console.error('These changed files touch user-facing flows:');
  for (const file of result.acceptanceFiles) console.error(`  - ${file}`);
  console.error('');
  console.error(`Update ${COVERAGE_MAP_PATH} to account for the change — add or update an entry with`);
  console.error('automated coverage (playwright-e2e / storybook / unit-dom), or manual (with a reason)');
  console.error('or deferred (with an issue). See the wiki Testing Strategy page.');
  console.error('');
  if (inputs.context.startsWith('PR #')) {
    console.error(`If this change genuinely has no acceptance-flow impact, CHECK the "${ACK_TOKEN}"`);
    console.error(`box in the PR description (or apply the "${ACK_TOKEN}" label) and re-run.`);
  } else {
    console.error(`If this change genuinely has no acceptance-flow impact, you can opt out once the PR`);
    console.error(`exists by adding "${ACK_TOKEN}" to its description or label — this local check has no`);
    console.error('PR to read yet, so it cannot honor that opt-out.');
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
