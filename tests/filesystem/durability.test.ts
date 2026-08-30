import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncDirectoryEntry, syncFileData } from '../../src/main/filesystem/durability.js';

describe('regular-file durability (#1080)', () => {
  test('opens owned staging files with write authority and closes after sync', async () => {
    const calls: string[] = [];

    await syncFileData('C:\\library\\tmp\\stage', (path, flags) => {
      assert.equal(path, 'C:\\library\\tmp\\stage');
      assert.equal(flags, 'r+');
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

  test('sync failures remain loud and still close the writable handle', async () => {
    let closed = false;
    const failure = new Error('injected file sync failure');

    await assert.rejects(
      syncFileData('/library/tmp/stage', () =>
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

  test('Windows fsync succeeds for a real writable staging file', { skip: process.platform !== 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'overlook-fsync-'));
    const path = join(directory, 'stage');
    try {
      await writeFile(path, 'durable');
      await syncFileData(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

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
