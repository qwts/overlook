import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { providerDescriptorSchema } from '../../shared/backup/provider-descriptor.js';
import { ProviderError, type StorageProvider } from './provider.js';

const PAYLOAD = Buffer.from('OVLK-object-provider-contract');

/** Provider-neutral encrypted-object contract shared by deterministic and signed-live adapters.
 *
 * Deletion semantics (#750): `delete` means "no longer visible to
 * list/get/verify" — the contract deliberately does NOT assert the object was
 * destroyed. Adapters must prefer the provider's recoverable deletion (Drive
 * trash, pCloud Trash, iCloud Recently Deleted); no code path may permanently
 * destroy a remote object where a recoverable deletion exists. */
export async function exerciseObjectProviderContract(browser: StorageProvider, libraryId: string): Promise<void> {
  const provider = browser.forLibrary(libraryId);
  const path = 'blobs/ab/abcdef';
  const bootstrap = 'recovery/bootstrap.ovrb';
  const librariesBefore = [...(await browser.listLibraries())].sort();
  assert.equal(librariesBefore.includes(libraryId), false, 'scratch library id must be unique');
  assert.equal(
    providerDescriptorSchema.safeParse({
      id: provider.id,
      label: provider.label,
      capabilities: provider.capabilities,
      available: true,
      unavailableReason: null,
    }).success,
    true,
  );
  try {
    assert.deepEqual(await provider.put(path, Readable.from([PAYLOAD])), { bytes: PAYLOAD.length });
    assert.deepEqual([...(await browser.listLibraries())].sort(), librariesBefore, 'blob-only upload preserves discovery baseline');
    await provider.put(bootstrap, Readable.from([PAYLOAD]));
    assert.ok((await browser.listLibraries()).includes(libraryId));
    assert.deepEqual(await provider.list('blobs'), [{ path, bytes: PAYLOAD.length }]);
    assert.deepEqual(await provider.probe(path), { bytes: PAYLOAD.length });
    assert.deepEqual(await buffer(await provider.getStream(path)), PAYLOAD);
    assert.deepEqual(await provider.verify(path), {
      sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
      bytes: PAYLOAD.length,
    });
  } finally {
    await provider.delete(path);
    await provider.delete(bootstrap);
  }
  assert.deepEqual(await provider.list('blobs'), []);
  await assert.rejects(provider.getStream(path), (error: unknown) => error instanceof ProviderError && error.kind === 'not-found');
}
