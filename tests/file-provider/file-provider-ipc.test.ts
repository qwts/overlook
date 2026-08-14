import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerFileProviderHandlersWith } from '../../src/main/file-provider/file-provider-ipc.js';
import type { FileProviderService } from '../../src/main/file-provider/file-provider-service.js';
import { disabledFileProviderConfig } from '../../src/shared/file-provider/contract.js';
import { channels } from '../../src/shared/ipc/channels.js';

describe('File Provider renderer IPC (#797)', () => {
  test('validates consent and admits only mutations', async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    let admitted = 0;
    let enabled = false;
    const service = {
      status: () => ({ available: true, reason: null, config: { ...disabledFileProviderConfig, enabled } }),
      availableAlbums: () => [{ id: 'A1', name: 'Travel', count: 2 }],
      enable: () => {
        enabled = true;
        return Promise.resolve();
      },
      disable: () => {
        enabled = false;
        return Promise.resolve();
      },
    } as unknown as FileProviderService;
    registerFileProviderHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      { handle: (channel, handler) => handlers.set(channel, handler) },
    );
    const invoke = (channel: string, request: unknown): Promise<unknown> => Promise.resolve(handlers.get(channel)?.({}, request));
    assert.equal(((await invoke(channels.fileProviderStatus.name, {})) as { config: { enabled: boolean } }).config.enabled, false);
    assert.deepEqual(await invoke(channels.fileProviderEnable.name, { scope: { kind: 'library' }, consentVersion: 0 }), {
      __overlookIpcFailure: true,
      error: { code: 'IPC_INVALID_REQUEST' },
    });
    assert.equal(admitted, 0, 'schema rejection must precede authorization');
    assert.equal(
      (
        (await invoke(channels.fileProviderEnable.name, { scope: { kind: 'library' }, consentVersion: 1 })) as {
          config: { enabled: boolean };
        }
      ).config.enabled,
      true,
    );
    assert.equal(((await invoke(channels.fileProviderDisable.name, {})) as { config: { enabled: boolean } }).config.enabled, false);
    assert.equal(admitted, 2);
  });
});
