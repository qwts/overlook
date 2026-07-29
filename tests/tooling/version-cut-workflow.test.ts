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
    assert.match(workflow, /token: \$\{\{ steps\.chores\.outputs\.token \|\| secrets\.RELEASE_TOKEN \|\| github\.token \}\}/u);
    assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \|\| secrets\.RELEASE_TOKEN \|\| github\.token \}\}/u);
    // The secrets context is unavailable in `if`, so presence is surfaced as env.
    assert.match(workflow, /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_APP_ID != '' \}\}/u);
  });

  test('never puts a repo credential in reach of a third-party action', () => {
    // The App key and the token it mints go to actions/* steps and our own run:
    // blocks only — anything else would hand a repo-scoped credential to code
    // whose future versions nobody here controls. This is why `changeset version`
    // is invoked as a CLI rather than through changesets/action, and why the
    // token is minted by actions/create-github-app-token rather than a
    // third-party equivalent (AGENTS.md → Branch And GitHub Hygiene).
    const foreign = [...workflow.matchAll(/^\s*uses: (?<action>[^@\s]+)/gmu)]
      .map((match) => match.groups?.['action'] ?? '')
      .filter((action) => !action.startsWith('actions/'));

    assert.deepEqual(foreign, []);
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
