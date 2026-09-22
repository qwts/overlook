import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlbumTreeConstraintError } from '../../src/shared/library/album-tree.js';
import { registerAlbumIpcHandlers } from '../../src/main/library/album-ipc.js';
import type { LibraryService } from '../../src/main/library/library-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { createInvoker, wrapHandler } from '../../src/shared/ipc/registry.js';
import { fakeRegistrar } from '../ipc/fake-registrar.js';

test('album moves expose only typed expected refusals through the validated transport', async () => {
  const { registrar, invoke } = fakeRegistrar();
  let failure: Error = new AlbumTreeConstraintError('cycle');
  let manifestChanges = 0;
  const service = {
    moveAlbum: () => {
      throw failure;
    },
  } as unknown as LibraryService;
  registerAlbumIpcHandlers(
    () => service,
    () => 'unused',
    wrapHandler,
    undefined,
    () => {
      manifestChanges += 1;
    },
    registrar,
  );
  const move = createInvoker(channels.albumMove, invoke);
  const request = { albumId: 'source', parentId: 'destination', position: 0 };
  for (const reason of ['cycle', 'depth'] as const) {
    failure = new AlbumTreeConstraintError(reason);
    assert.deepEqual(await move(request), { refusal: reason });
  }
  failure = new Error('private database detail');
  await assert.rejects(move(request), { message: 'IPC_HANDLER_FAILED' });
  assert.equal(manifestChanges, 0, 'refused and failed moves do not publish manifest success');
});
