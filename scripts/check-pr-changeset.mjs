import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { addedChangesetFiles, isReleaseChangeset } from './pr-changeset.mjs';

const baseRef = process.env.BASE_REF ?? 'origin/main';
const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--', '.changeset'], {
  encoding: 'utf8',
});
const files = addedChangesetFiles(diff);
const semanticChangeset = files.find((file) => isReleaseChangeset(readFileSync(file, 'utf8')));

if (semanticChangeset === undefined) {
  console.error(`Add a semantic changeset (.changeset/*.md with a major, minor, or patch release) relative to ${baseRef}.`);
  process.exit(1);
}

console.log(`Validated semantic changeset: ${semanticChangeset}`);
