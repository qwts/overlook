import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerVariantHandlersWith } from '../../src/main/library/variant-ipc.js';
import type { VariantService } from '../../src/main/library/variant-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #496 / ADR-0031 §3 + §7: Duplicate and Promote change library data and
// owe the backup a manifest generation; reading a family owes nothing.

const FAMILY = { contentHash: 'h'.repeat(64), representativeId: null, variants: [] };

describe('variant IPC adapters (#496)', () => {
  test('admits every channel and owes the manifest for created duplicates and promotions', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    let manifestChanged = 0;
    let created: { sourceId: string; photoId: string; derivatives: 'regenerated' }[] = [];
    const service = {
      duplicate: () => Promise.resolve({ created, skipped: 0, unsupported: 0, pendingCount: 0 }),
      family: () => FAMILY,
      promote: () => FAMILY,
    } as unknown as VariantService;
    registerVariantHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
      () => {
        manifestChanged += 1;
      },
    );
    assert.equal(registered().length, 3);

    const nothing = (await invoke(channels.photoDuplicate.name, { photoIds: ['missing'] })) as { created: unknown[] };
    assert.equal(nothing.created.length, 0);
    assert.equal(manifestChanged, 0);
    created = [{ sourceId: 'P1', photoId: 'P1-copy', derivatives: 'regenerated' }];
    const duplicated = (await invoke(channels.photoDuplicate.name, { photoIds: ['P1'] })) as { created: unknown[] };
    assert.equal(duplicated.created.length, 1);
    assert.equal(manifestChanged, 1);
    assert.deepEqual(await invoke(channels.photoVariants.name, { photoId: 'P1' }), FAMILY);
    assert.equal(manifestChanged, 1);
    assert.deepEqual(await invoke(channels.photoPromoteVariant.name, { photoId: 'P1-copy' }), FAMILY);
    assert.equal(manifestChanged, 2);
    assert.equal(admitted, 4);
  });

  test('refuses an empty selection before admitting', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    registerVariantHandlersWith(
      () => ({}) as VariantService,
      () => {
        admitted += 1;
      },
      registrar,
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.photoDuplicate.name, { photoIds: [] }), INVALID_REQUEST);
    });
    assert.equal(admitted, 0);
    assert.equal(logged.length, 1);
  });
});
