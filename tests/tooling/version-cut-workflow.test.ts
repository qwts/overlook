import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('version-cut workflow', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/version-cut.yml'), 'utf8');

  test('starts downstream runs as chores-dumb[bot], never as GITHUB_TOKEN', () => {
    // The version PR is opened and force-refreshed by chores-dumb[bot] so it gets
    // real pull_request CI runs, and the tag is pushed with that token so
    // release.yml's on:push:tags trigger fires. GITHUB_TOKEN events start no
    // workflows at all, and github-actions[bot] is not an authorized actor here —
    // its runs fail at startup with "Actor is not allowed to trigger Actions
    // workflows". A bot rather than a human PAT also keeps the version PR
    // approvable: qwts cannot approve a PR qwts opened (ENG-0045 decision 4).
    assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40}/u);
    assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \|\| secrets\.RELEASE_TOKEN \|\| github\.token \}\}/u);
    // The secrets context is unavailable in `if`, so presence is surfaced as env.
    assert.match(workflow, /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID != '' \}\}/u);
  });

  test('a bad App key degrades to the fallback tokens, never a failed job', () => {
    // continue-on-error on every mint step: a malformed CHORES_DUMB_PRIVATE_KEY
    // fails the step — and with it the job — before the
    // `steps.chores.outputs.token || …` fallbacks can apply. Both jobs mint, so
    // both must be non-fatal (PR #838 review: the tag job was left fatal and
    // every push to main still died there).
    const mints = workflow.split(/- name: Mint the chores-dumb token/u).slice(1);
    assert.equal(mints.length, 2);
    for (const mint of mints) {
      const beforeUses = mint.split('uses:')[0] ?? '';
      assert.match(beforeUses, /continue-on-error: true/u);
    }
  });

  test('never puts a repo credential in reach of a third-party action', () => {
    // The App key and the token it mints never go to a third-party action. The
    // token is minted by actions/create-github-app-token rather than a
    // third-party equivalent (AGENTS.md → Branch And GitHub Hygiene).
    const foreign = [...workflow.matchAll(/^\s*uses: (?<action>[^@\s]+)/gmu)]
      .map((match) => match.groups?.['action'] ?? '')
      .filter((action) => !action.startsWith('actions/'));

    assert.deepEqual(foreign, []);
  });

  test('keeps repository credentials away from the changeset CLI', () => {
    const versionJob = workflow.split(/^  tag:/mu)[0] ?? '';
    const versionStep = versionJob.split('- name: Create the Version packages commit')[1]?.split('- name: Push and refresh')[0] ?? '';

    assert.match(versionJob, /persist-credentials: false/u);
    assert.match(versionStep, /npx changeset version/u);
    assert.doesNotMatch(versionStep, /GH_TOKEN|RELEASE_TOKEN|steps\.chores\.outputs\.token/u);
    assert.match(versionJob, /if: steps\.version\.outputs\.ready == 'true'/u);
  });

  test('hand-dispatches nothing but stranded-tag recovery', () => {
    // Replaces the old "dispatch version-branch checks only after Changesets
    // creates the PR" guard: that dispatch existed to work around GITHUB_TOKEN
    // events triggering nothing, and it is itself a bot action the actor policy
    // refuses. Only the recovery dispatch survives — an already-existing tag has
    // no push event left to replay.
    assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
    assert.deepEqual(workflow.match(/gh workflow run \S+/gu), ['gh workflow run release.yml']);
  });
});
