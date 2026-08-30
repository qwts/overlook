import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { syncDirectoryEntry } from '../../src/main/filesystem/durability.js';

describe('directory-entry durability (#1073)', () => {
  test('Windows skips the unsupported directory sync without opening the directory', async () => {
    let opened = false;

    await syncDirectoryEntry('C:\\library\\blobs', 'win32', () => {
      opened = true;
      throw new Error('Windows directory handles must not be opened for sync');
    });

    assert.equal(opened, false);
  });

  test('supported platforms sync and close the directory handle', async () => {
    const calls: string[] = [];

    await syncDirectoryEntry('/library/blobs', 'linux', (path) => {
      assert.equal(path, '/library/blobs');
      return Promise.resolve({
        sync() {
          calls.push('sync');
          return Promise.resolve();
        },
        close() {
          calls.push('close');
          return Promise.resolve();
        },
      });
    });

    assert.deepEqual(calls, ['sync', 'close']);
  });

  test('supported-platform sync failures remain loud and still close the handle', async () => {
    let closed = false;
    const failure = new Error('injected directory sync failure');

    await assert.rejects(
      syncDirectoryEntry('/library/blobs', 'darwin', () =>
        Promise.resolve({
          sync() {
            return Promise.reject(failure);
          },
          close() {
            closed = true;
            return Promise.resolve();
          },
        }),
      ),
      failure,
    );

    assert.equal(closed, true);
  });
});
