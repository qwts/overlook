import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  RELEASE_IMPORT_SMOKE_ARGUMENT,
  RELEASE_IMPORT_SMOKE_ERROR_MARKER,
  RELEASE_IMPORT_SMOKE_READY_MARKER,
  RELEASE_SMOKE_ARGUMENT,
  RELEASE_SMOKE_READY_MARKER,
  exitForReleaseSmokeIfRequested,
  releaseImportSmokeProfileIfRequested,
} from '../../src/main/release-smoke.js';

function smokeApp(profile = join(tmpdir(), 'overlook-release-import-smoke-test')) {
  mkdirSync(profile, { recursive: true });
  const exits: number[] = [];
  return {
    app: { isPackaged: true, getPath: () => profile, exit: (code: number) => exits.push(code) },
    exits,
    profile,
  };
}

describe('packaged release launch smoke (#357)', () => {
  test('does not intercept normal launches', async () => {
    const { app, exits } = smokeApp();
    assert.equal(await exitForReleaseSmokeIfRequested(app, ['Overlook']), false);
    assert.deepEqual(exits, []);
  });

  test('emits a stable readiness boundary for the verifier', async () => {
    let marker = '';
    const { app, exits } = smokeApp();
    assert.equal(
      await exitForReleaseSmokeIfRequested(app, ['Overlook', RELEASE_SMOKE_ARGUMENT], (value) => {
        marker = value;
      }),
      true,
    );
    assert.equal(marker, `${RELEASE_SMOKE_READY_MARKER}\n`);
    assert.deepEqual(exits, [0]);
  });

  test('the production writer flushes the marker synchronously before exit', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/release-smoke.ts'), 'utf8');
    assert.match(source, /writeSync\(process\.stdout\.fd/u);
  });

  test('runs an import only with an absolute isolated profile matching Electron userData', async () => {
    const { app, exits, profile } = smokeApp();
    const source = join(tmpdir(), 'overlook-release-import-fixture.jpg');
    let request: { readonly sourcePath: string; readonly profilePath: string } | undefined;
    let output = '';
    const handled = await exitForReleaseSmokeIfRequested(
      app,
      [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-source=${source}`,
        `--overlook-release-import-profile=${profile}`,
      ],
      (value) => (output += value),
      (value) => {
        request = value;
        return Promise.resolve();
      },
    );
    assert.equal(handled, true);
    assert.deepEqual(request, { sourcePath: source, profilePath: await realpath(profile) });
    assert.equal(output, `${RELEASE_IMPORT_SMOKE_READY_MARKER}\n`);
    assert.deepEqual(exits, [0]);
  });

  test('selects the isolated profile before packaged app-profile configuration', () => {
    const { profile } = smokeApp();
    const resultPath = join(profile, 'release-import-result.txt');

    assert.equal(
      releaseImportSmokeProfileIfRequested({ isPackaged: true }, [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-profile=${profile}`,
        `--overlook-release-import-result=${resultPath}`,
      ]),
      profile,
    );
    assert.match(readFileSync(resultPath, 'utf8'), /overlook-release-import-smoke:progress:profile-bound/u);
    assert.equal(
      releaseImportSmokeProfileIfRequested({ isPackaged: false }, [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-profile=${profile}`,
        `--overlook-release-import-result=${resultPath}`,
      ]),
      undefined,
    );
  });

  test('fails closed when the import profile is not the active isolated profile', async () => {
    const { app, exits } = smokeApp();
    let output = '';
    await exitForReleaseSmokeIfRequested(
      app,
      [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-source=${join(tmpdir(), 'fixture.jpg')}`,
        `--overlook-release-import-profile=${join(tmpdir(), 'overlook-release-import-smoke-other')}`,
      ],
      (value) => (output += value),
    );
    assert.match(output, new RegExp(`^${RELEASE_IMPORT_SMOKE_ERROR_MARKER}:`, 'u'));
    assert.deepEqual(exits, [1]);
  });
});
