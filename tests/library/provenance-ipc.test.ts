import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registerProvenanceHandlersWith } from '../../src/main/library/provenance-ipc.js';
import type { ProvenanceService } from '../../src/main/library/provenance-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #495 / ADR-0031 §5 + §7: reads evaluate lazily; only a freshly written
// record owes the backup a manifest generation.

function payload(status: 'evaluated' | 'deferred') {
  return { photoId: 'P1', evidence: null, unsupported: null, stale: false, status };
}

describe('provenance IPC adapters (#495)', () => {
  test('admits both channels and owes the manifest only after a fresh evaluation', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    let manifestChanged = 0;
    let refreshStatus: 'evaluated' | 'deferred' = 'deferred';
    const service = {
      current: () => ({ evidence: null }),
      get: () => Promise.resolve(payload('evaluated')),
      refresh: () => Promise.resolve(payload(refreshStatus)),
    } as unknown as ProvenanceService;
    registerProvenanceHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
      () => {
        manifestChanged += 1;
      },
    );
    assert.deepEqual([...registered()].sort(), [channels.photoProvenance.name, channels.photoProvenanceRefresh.name].sort());

    // Nothing evaluated: no record was written, so nothing is owed.
    assert.deepEqual(await invoke(channels.photoProvenance.name, { photoId: 'P1' }), payload('evaluated'));
    assert.equal(manifestChanged, 0);
    assert.deepEqual(await invoke(channels.photoProvenanceRefresh.name, { photoId: 'P1' }), payload('deferred'));
    assert.equal(manifestChanged, 0);
    refreshStatus = 'evaluated';
    await invoke(channels.photoProvenanceRefresh.name, { photoId: 'P1' });
    assert.equal(manifestChanged, 1);
    assert.equal(admitted, 3);
  });

  test('refuses an empty photo id before admitting', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    registerProvenanceHandlersWith(
      () => ({}) as ProvenanceService,
      () => {
        admitted += 1;
      },
      registrar,
    );
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(await invoke(channels.photoProvenance.name, { photoId: '' }), INVALID_REQUEST);
    });
    assert.equal(admitted, 0);
    assert.equal(logged.length, 1);
  });
});
