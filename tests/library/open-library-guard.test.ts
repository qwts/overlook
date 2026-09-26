import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openWithLibraryLock } from '../../src/main/library/open-library-guard.js';

test('a throw on the first acquire releases the library lock', () => {
  let released = false;
  assert.throws(
    () =>
      openWithLibraryLock({
        dataDir: '/library',
        instanceId: 'instance',
        heldRelease: undefined,
        acquire: () => () => {
          released = true;
        },
        open: () => {
          throw new Error('unwrap');
        },
      }),
    /unwrap/u,
  );
  assert.equal(released, true);
});

test('a throw keeps a lock this process already held', () => {
  let released = false;
  let acquired = false;
  assert.throws(
    () =>
      openWithLibraryLock({
        dataDir: '/library',
        instanceId: 'instance',
        heldRelease: () => {
          released = true;
        },
        acquire: () => {
          acquired = true;
          return () => undefined;
        },
        open: () => {
          throw new Error('unwrap');
        },
      }),
    /unwrap/u,
  );
  assert.equal(acquired, false);
  assert.equal(released, false);
});

test('a successful open returns the held release without calling it', () => {
  let released = false;
  const opened = openWithLibraryLock({
    dataDir: '/library',
    instanceId: 'instance',
    heldRelease: undefined,
    acquire: () => () => {
      released = true;
    },
    open: () => 'store',
  });
  assert.equal(opened.value, 'store');
  assert.equal(released, false);
  opened.release();
  assert.equal(released, true);
});
