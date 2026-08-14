import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type { StorageProvider } from './provider.js';

const OBJECTS = [
  { path: 'recovery/bootstrap.ovrb', bytes: Buffer.from('OVRB-contract-bootstrap') },
  { path: 'manifest/gen-1.ovlk', bytes: Buffer.from('OVLK-contract-manifest') },
  { path: 'blobs/ab/abcdef', bytes: Buffer.from('OVLK-contract-blob') },
] as const;

/** Provider-neutral restore boundary shared by deterministic and signed-live adapters. */
export async function exerciseRestoreProviderContract(browser: StorageProvider, libraryId: string): Promise<void> {
  const scoped = browser.forLibrary(libraryId);
  assert.equal(await scoped.authState(), 'connected');
  try {
    for (const object of OBJECTS) {
      assert.deepEqual(await scoped.put(object.path, Readable.from([object.bytes])), { bytes: object.bytes.length });
      assert.deepEqual(await scoped.verify(object.path), {
        bytes: object.bytes.length,
        sha256: createHash('sha256').update(object.bytes).digest('hex'),
      });
    }
    assert.ok((await browser.listLibraries()).includes(libraryId));
    const discovered = browser.forLibrary(libraryId);
    for (const object of OBJECTS) {
      assert.deepEqual(await discovered.probe(object.path), { bytes: object.bytes.length });
      assert.deepEqual(await buffer(await discovered.getStream(object.path)), object.bytes);
    }
    assert.deepEqual(await discovered.list('manifest'), [{ path: 'manifest/gen-1.ovlk', bytes: OBJECTS[1].bytes.length }]);
  } finally {
    const cleanup = await Promise.allSettled([...OBJECTS].reverse().map((object) => scoped.delete(object.path)));
    assert.equal(cleanup.filter((result) => result.status === 'rejected').length, 0, 'provider contract removes every scratch object');
  }
}
