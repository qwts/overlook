import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createInteropJsonSchemas } from '../.test-dist/src/shared/interop/json-schema.js';

const contractDirectory = path.resolve('design/handoff/contracts/v1');
const fixtureDirectory = path.join(contractDirectory, 'fixtures');

for (const [fileName, schema] of Object.entries(createInteropJsonSchemas())) {
  await writeFile(path.join(contractDirectory, fileName), `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

const schemaFiles = Object.keys(createInteropJsonSchemas()).sort();
const evidenceFiles = ['acceptance-evidence.json', 'provider-root.json', 'sealed-blob.md'];
const fixtureFiles = (await readdir(fixtureDirectory))
  .filter((fileName) => fileName.endsWith('.json'))
  .sort()
  .map((fileName) => path.join('fixtures', fileName));
const contractFiles = [...schemaFiles, ...evidenceFiles, ...fixtureFiles].sort();
const checksumLines = [];

for (const relativePath of contractFiles) {
  const contents = await readFile(path.join(contractDirectory, relativePath));
  checksumLines.push(`${createHash('sha256').update(contents).digest('hex')}  ${relativePath}`);
}

await writeFile(path.join(contractDirectory, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, 'utf8');
