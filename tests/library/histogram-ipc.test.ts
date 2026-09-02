import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerHistogramHandlersWith } from '../../src/main/library/histogram-ipc.js';
import type { HistogramService } from '../../src/main/library/histogram-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #498: one read-only lookup per photo, admitted through the app-lock gate;
// an unavailable answer names why rather than fabricating bins.

describe('histogram IPC adapter (#498)', () => {
  test('admits the lookup and returns the service answer as-is', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    const asked: string[] = [];
    const service = {
      get: (photoId: string) => {
        asked.push(photoId);
        return { state: 'unavailable', photoId, reason: 'missing' };
      },
    } as unknown as HistogramService;
    registerHistogramHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
    );
    assert.deepEqual(registered(), [channels.photoHistogram.name]);
    assert.deepEqual(await invoke(channels.photoHistogram.name, { photoId: 'P1' }), {
      state: 'unavailable',
      photoId: 'P1',
      reason: 'missing',
    });
    assert.deepEqual(asked, ['P1']);
    assert.equal(admitted, 1);
  });

  test('refuses an empty photo id before admitting', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    registerHistogramHandlersWith(
      () => ({}) as HistogramService,
      () => {
        admitted += 1;
      },
      registrar,
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.photoHistogram.name, { photoId: '' }), INVALID_REQUEST);
    });
    assert.equal(admitted, 0);
    assert.match(logged[0] ?? '', /IPC_INVALID_REQUEST on photo:histogram/);
  });
});
