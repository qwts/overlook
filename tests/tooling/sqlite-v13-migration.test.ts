import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();
const dependencyName = 'better-sqlite3-multiple-ciphers';
const declarationPath = `./node_modules/${dependencyName}/index.d.ts`;

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

describe('encrypted SQLite v13 migration (#1020)', () => {
  test('pins the reviewed Node-API release without a stale install-script grant', () => {
    const manifest = json('package.json');
    const dependencies = manifest['dependencies'] as Record<string, string>;
    const allowScripts = manifest['allowScripts'] as Record<string, boolean>;
    const lock = json('package-lock.json');
    const packages = lock['packages'] as Record<string, Record<string, unknown>>;
    const locked = packages[`node_modules/${dependencyName}`] ?? {};

    assert.equal(dependencies[dependencyName], '13.0.3');
    assert.equal(
      Object.keys(allowScripts).some((name) => name.startsWith(`${dependencyName}@`)),
      false,
    );
    assert.equal(locked['version'], '13.0.3');
    assert.equal(locked['hasInstallScript'], undefined);
    assert.deepEqual(locked['engines'], { node: '>=22' });
  });

  test("resolves the package-owned declarations around v13's incomplete exports map", () => {
    const tsconfig = json('tsconfig.json');
    const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown>;
    const paths = compilerOptions['paths'] as Record<string, string[]>;
    const dependencyManifest = json(`node_modules/${dependencyName}/package.json`);

    assert.deepEqual(paths[dependencyName], [declarationPath]);
    assert.equal(dependencyManifest['types'], 'index.d.ts');
    assert.equal(dependencyManifest['gypfile'], false);
    assert.equal(existsSync(join(root, declarationPath)), true);
  });
});
