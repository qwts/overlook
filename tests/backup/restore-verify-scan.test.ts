import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderError, type StorageProvider } from '../../src/main/backup/provider.js';
import { listObjectBytes, presentBytes, addPresenceFingerprint, createScanTicker } from '../../src/main/backup/restore-verify-scan.js';

function listingProvider(
  entries: ReadonlyMap<string, readonly { path: string; bytes: number }[]>,
  sizes: ReadonlyMap<string, number>,
): StorageProvider {
  return {
    list: (prefix) => Promise.resolve(entries.get(prefix) ?? []),
    probe: (path) => {
      const bytes = sizes.get(path);
      if (bytes === undefined) return Promise.reject(new ProviderError(`no remote entry at ${path}`, 'not-found'));
      return Promise.resolve({ bytes });
    },
  } as StorageProvider;
}

test('listObjectBytes walks leaf prefixes and ignores unsplittable paths', async () => {
  const provider = listingProvider(
    new Map([
      [
        'blobs/aa',
        [
          { path: 'blobs/aa/hit', bytes: 4 },
          { path: 'blobs/aa/other', bytes: 2 },
        ],
      ],
    ]),
    new Map(),
  );
  const listed = await listObjectBytes(provider, ['blobs/aa/hit', 'orphan']);
  assert.equal(listed.get('blobs/aa/hit'), 4);
  assert.equal(listed.has('orphan'), false);
});

test('presentBytes uses the listing hit and probes only misses', async () => {
  const probes: string[] = [];
  const provider = listingProvider(new Map([['blobs/aa', [{ path: 'blobs/aa/hit', bytes: 4 }]]]), new Map([['blobs/bb/miss', 7]]));
  const listed = await listObjectBytes(provider, ['blobs/aa/hit']);
  const inner = provider.probe.bind(provider);
  provider.probe = (path, signal) => {
    probes.push(path);
    return inner(path, signal);
  };
  assert.equal(await presentBytes(provider, listed, 'blobs/aa/hit'), 4);
  assert.deepEqual(probes, []);
  assert.equal(await presentBytes(provider, listed, 'blobs/bb/miss'), 7);
  assert.deepEqual(probes, ['blobs/bb/miss']);
});

test('presence fingerprints and the scan ticker count every object', () => {
  const fingerprints: string[] = [];
  addPresenceFingerprint(fingerprints, 'blobs/aa/hit', 4);
  assert.deepEqual(fingerprints, ['blobs/aa/hit\u00004']);
  const progress: Array<{ done: number; total: number }> = [];
  const ticker = createScanTicker(2, (_stage, done, total) => progress.push({ done, total }));
  ticker.tick('P1');
  ticker.tick('P2');
  assert.deepEqual(progress, [
    { done: 0, total: 2 },
    { done: 1, total: 2 },
    { done: 2, total: 2 },
  ]);
});
