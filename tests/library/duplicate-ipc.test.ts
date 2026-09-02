import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerDuplicateHandlersWith } from '../../src/main/library/duplicate-ipc.js';
import type { DuplicateIndexService } from '../../src/main/library/duplicate-index-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #650: the review is derived on demand and the rescan is explicit; both
// admit through the app-lock gate first.

const STATUS = { total: 4, indexed: 3, deferred: 1, pending: 0 };

describe('duplicate review IPC adapters (#650)', () => {
  test('admits both channels and forwards the review and the rescan', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    let rescans = 0;
    const review = { version: 'phash-1', threshold: 10, status: STATUS, groups: [] };
    const service = {
      reviewWithPhotos: () => review,
      rescan: () => {
        rescans += 1;
        return { ...STATUS, indexed: 0, pending: 4 };
      },
    } as unknown as DuplicateIndexService;
    registerDuplicateHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
    );
    assert.deepEqual([...registered()].sort(), [channels.duplicatesRescan.name, channels.duplicatesReview.name].sort());

    assert.deepEqual(await invoke(channels.duplicatesReview.name, {}), review);
    assert.deepEqual(await invoke(channels.duplicatesRescan.name, {}), { ...STATUS, indexed: 0, pending: 4 });
    assert.equal(rescans, 1);
    assert.equal(admitted, 2);
  });

  test('never widens a malformed review into the renderer', async () => {
    const { registrar, invoke } = fakeRegistrar();
    const service = {
      reviewWithPhotos: () => ({ version: '', threshold: 99, status: STATUS, groups: [] }),
    } as unknown as DuplicateIndexService;
    registerDuplicateHandlersWith(
      () => service,
      () => undefined,
      registrar,
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.duplicatesReview.name, {}), {
        ...INVALID_REQUEST,
        error: { code: 'IPC_INVALID_RESPONSE' },
      });
    });
    assert.match(logged[0] ?? '', /IPC_INVALID_RESPONSE on duplicates:review/);
  });
});
