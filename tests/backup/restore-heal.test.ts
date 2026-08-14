import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { healRemoteGaps } from '../../src/main/backup/restore-heal.js';

test('heal writes the gap list and moves only corrupt objects aside', async () => {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-heal-')) });
  await provider.put('blobs/aa/good', Readable.from([Buffer.from('keep')]));
  await provider.put('blobs/bb/bad', Readable.from([Buffer.from('corrupt')]));
  await healRemoteGaps(provider, 59, [
    { path: 'blobs/cc/gone', kind: 'original', photoId: 'P1', reason: 'not-found' },
    { path: 'blobs/bb/bad', kind: 'original', photoId: 'P2', reason: 'failed-verification' },
  ]);
  const report = JSON.parse((await buffer(await provider.getStream('quarantine/gen-59/gaps.json'))).toString('utf8')) as {
    missing: readonly { path: string }[];
  };
  assert.deepEqual(
    report.missing.map((item) => item.path),
    ['blobs/cc/gone', 'blobs/bb/bad'],
  );
  assert.deepEqual(await buffer(await provider.getStream('blobs/aa/good')), Buffer.from('keep'));
  assert.deepEqual(await buffer(await provider.getStream('quarantine/gen-59/blobs/bb/bad')), Buffer.from('corrupt'));
  await assert.rejects(provider.getStream('blobs/bb/bad'), (error: unknown) => error instanceof Error);
});

test('heal is a no-op when every object verified', async () => {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-heal-clean-')) });
  await healRemoteGaps(provider, 1, []);
  assert.deepEqual(await provider.list('quarantine'), []);
});

test('heal still writes the gap list when a corrupt object cannot be copied or deleted', async () => {
  const provider = new MockProvider({ rootDir: mkdtempSync(join(tmpdir(), 'overlook-heal-fail-')) });
  await provider.put('blobs/bb/bad', Readable.from([Buffer.from('corrupt')]));
  provider.getStream = () => Promise.reject(new Error('unreadable'));
  provider.delete = () => Promise.reject(new Error('busy'));
  await healRemoteGaps(provider, 3, [{ path: 'blobs/bb/bad', kind: 'original', photoId: 'P2', reason: 'failed-verification' }]);
  const report = JSON.parse((await buffer(await provider.getStream('quarantine/gen-3/gaps.json'))).toString('utf8')) as {
    missing: readonly { path: string }[];
  };
  assert.deepEqual(
    report.missing.map((item) => item.path),
    ['blobs/bb/bad'],
  );
});
