import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.cwd();

interface ClosureRecord {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseText: string | null;
  readonly conditional?: boolean;
}

interface NoticesModule {
  readonly assertLicenseTextsResolvable: (closure: readonly ClosureRecord[]) => void;
}

interface DependencyClosureModule {
  readonly resolveShippedClosure: () => readonly ClosureRecord[];
}

function noticesModule(): Promise<NoticesModule> {
  return import(pathToFileURL(join(root, 'scripts/generate-third-party-notices.mjs')).href) as Promise<NoticesModule>;
}

function dependencyClosureModule(): Promise<DependencyClosureModule> {
  return import(pathToFileURL(join(root, 'scripts/dependency-closure.mjs')).href) as Promise<DependencyClosureModule>;
}

function pkg(name: string, licenseText: string | null, conditional = false): ClosureRecord {
  return { name, version: '1.0.0', license: 'MIT', licenseText, conditional };
}

// License texts are read from installed packages while the closure comes from the
// lockfile. An absent or half-populated node_modules therefore yields a closure whose
// every entry has licenseText === null, which renders as the same "no license text"
// note used for packages that genuinely ship none — producing a notices file with an
// intact package table and no attribution, which --check then certifies because it
// re-renders from the same broken input. These pin the guard that stops it.
describe('third-party notices license-text guard', () => {
  test('accepts a closure where non-optional packages resolved their texts', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('a', 'MIT text'), pkg('b', 'MIT text'), pkg('c', null)];
    assert.doesNotThrow(() => assertLicenseTextsResolvable(closure));
  });

  test('rejects a closure where no non-optional package resolved a text', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('a', null), pkg('b', null), pkg('c', null)];
    assert.throws(() => assertLicenseTextsResolvable(closure), /npm install/u);
  });

  test('rejects a majority-empty closure rather than writing partial attribution', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('a', 'MIT text'), pkg('b', null), pkg('c', null), pkg('d', null)];
    assert.throws(() => assertLicenseTextsResolvable(closure), /incomplete node_modules/u);
  });

  test('optional platform variants are exempt — they are never installed on one host', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('sharp-linux-x64', null, true), pkg('sharp-win32-x64', null, true)];
    assert.doesNotThrow(() => assertLicenseTextsResolvable(closure));
  });

  test('the real shipped closure passes the guard', async () => {
    const [{ assertLicenseTextsResolvable }, { resolveShippedClosure }] = await Promise.all([noticesModule(), dependencyClosureModule()]);
    // Regression pin on the guard's own margin: if a future dependency set legitimately
    // pushed the resolved fraction under the floor, this fails here rather than by
    // blocking an unrelated PR at the licences gate.
    assert.doesNotThrow(() => assertLicenseTextsResolvable(resolveShippedClosure()));
  });
});
