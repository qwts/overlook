import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { ICloudDriveNativeBridge } from '../../src/main/backup/icloud-drive/native-bridge.js';
import {
  ICLOUD_NATIVE_SMOKE_ARGUMENT,
  ICLOUD_NATIVE_SMOKE_READY_MARKER,
  runICloudNativeSmokeIfRequested,
} from '../../src/main/backup/icloud-drive/native-smoke.js';

function fakeBridge(): ICloudDriveNativeBridge & { readonly deleted: string[] } {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  return {
    deleted,
    drain: () => Promise.resolve(),
    status: () => Promise.resolve({ available: true, reason: null, accountToken: '0123456789abcdef' }),
    replaceFile: async (path, source) => {
      objects.set(path, await import('node:fs/promises').then(({ readFile }) => readFile(source)));
    },
    materializeFile: async (path, destination) => {
      const value = objects.get(path);
      if (value === undefined) throw new Error('missing');
      await import('node:fs/promises').then(({ writeFile }) => writeFile(destination, value));
    },
    list: (path) =>
      Promise.resolve({
        entries: [...objects.entries()]
          .filter(([key]) => key.startsWith(`${path}/`))
          .map(([key, value]) => ({
            path: key,
            size: value.length,
            modifiedAt: '2026-07-21T00:00:00.000Z',
            downloaded: true,
            conflicted: false,
          })),
        nextCursor: null,
        accountToken: '0123456789abcdef',
      }),
    delete: (path) => {
      deleted.push(path);
      objects.delete(path);
      return Promise.resolve();
    },
  };
}

describe('packaged iCloud native smoke (#656)', () => {
  test('the documented npm entrypoint runs under the process-tree guard', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.['test:icloud:native-smoke'] ?? '';
    assert.match(command, /tools\/agent-guard\/run-guarded\.mjs/u);
    assert.match(command, /--label test:icloud:native-smoke/u);
    assert.match(command, /scripts\/verify-macos-icloud-native-smoke\.mjs/u);
  });

  test('does not intercept a normal launch', async () => {
    const exits: number[] = [];
    assert.equal(
      await runICloudNativeSmokeIfRequested(
        { isPackaged: true, exit: (code) => exits.push(code) },
        { argv: ['Overlook'], bridge: fakeBridge() },
      ),
      false,
    );
    assert.deepEqual(exits, []);
  });

  test('round-trips and removes an isolated coordinated scratch object', async () => {
    const exits: number[] = [];
    const output: string[] = [];
    const bridge = fakeBridge();
    assert.equal(
      await runICloudNativeSmokeIfRequested(
        { isPackaged: true, exit: (code) => exits.push(code) },
        { argv: ['Overlook', ICLOUD_NATIVE_SMOKE_ARGUMENT], bridge, write: (value) => output.push(value) },
      ),
      true,
    );
    assert.deepEqual(exits, [0]);
    assert.deepEqual(output, [`${ICLOUD_NATIVE_SMOKE_READY_MARKER}\n`]);
    assert.equal(bridge.deleted.length, 1);
  });

  test('fails closed and exits nonzero when the signed authority is unavailable', async () => {
    const exits: number[] = [];
    const output: string[] = [];
    const bridge = fakeBridge();
    bridge.status = () => Promise.resolve({ available: false, reason: 'unentitled', accountToken: null });
    await runICloudNativeSmokeIfRequested(
      { isPackaged: true, exit: (code) => exits.push(code) },
      { argv: ['Overlook', ICLOUD_NATIVE_SMOKE_ARGUMENT], bridge, write: (value) => output.push(value) },
    );
    assert.deepEqual(exits, [1]);
    assert.match(output.join(''), /iCloud unavailable: unentitled/u);
  });
});
