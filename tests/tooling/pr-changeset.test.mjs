import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addedChangesetFiles, isReleaseChangeset } from '../../scripts/pr-changeset.mjs';

describe('PR changeset requirement', () => {
  test('accepts only newly added changeset markdown files', () => {
    assert.deepEqual(addedChangesetFiles('.changeset/release.md\n.changeset/README.md\nsrc/app.ts\n'), ['.changeset/release.md']);
  });

  test('requires a semantic release entry instead of an empty governance marker', () => {
    assert.equal(isReleaseChangeset('---\n---\n'), false);
    assert.equal(isReleaseChangeset("---\n'overlook': patch\n---\nDescribe the release.\n"), true);
  });
});
