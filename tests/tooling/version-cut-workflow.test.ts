import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('version-cut workflow', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/version-cut.yml'), 'utf8');

  test('starts downstream runs under RELEASE_TOKEN, never the bot token', () => {
    // The version PR is opened and force-refreshed by the PAT so it gets real
    // pull_request CI runs, and the tag is pushed with the PAT so release.yml's
    // on:push:tags trigger fires. GITHUB_TOKEN events start no workflows at all,
    // and github-actions[bot] is not an authorized actor here — its runs fail at
    // startup with "Actor is not allowed to trigger Actions workflows".
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.RELEASE_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}/u);
    assert.match(workflow, /token: \$\{\{ secrets\.RELEASE_TOKEN \|\| github\.token \}\}/u);
    assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.RELEASE_TOKEN \|\| github\.token \}\}/u);
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
