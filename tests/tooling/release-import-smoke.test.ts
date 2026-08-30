import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { runReleaseImportSmoke } from '../../src/main/release-import-smoke.js';

describe('packaged release import smoke (#1083)', () => {
  test('proves the record, decrypted custody, source preservation, and no plaintext at rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overlook-release-import-smoke-test-'));
    const profile = join(root, 'profile');
    const sourcePath = join(root, 'fixture.jpg');
    const source = Buffer.concat([Buffer.alloc(700, 17), Buffer.from('unique-release-import-smoke-plaintext')]);
    await mkdir(profile);
    await writeFile(sourcePath, source);
    const contentHash = createHash('sha256').update(source).digest('hex');
    try {
      await runReleaseImportSmoke(sourcePath, profile, {
        runCopy: () => Promise.resolve({ imported: 1, failed: 0, cancelled: 0, duplicates: 0, photoIds: ['photo-1'] }),
        record: () => ({ id: 'photo-1', contentHash }),
        readOriginal: () => Readable.from(source),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects plaintext bytes persisted under the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overlook-release-import-smoke-test-'));
    const profile = join(root, 'profile');
    const sourcePath = join(root, 'fixture.jpg');
    const source = Buffer.alloc(700, 29);
    await mkdir(profile);
    await writeFile(sourcePath, source);
    await writeFile(join(profile, 'leak.bin'), source);
    const contentHash = createHash('sha256').update(source).digest('hex');
    try {
      await assert.rejects(
        runReleaseImportSmoke(sourcePath, profile, {
          runCopy: () => Promise.resolve({ imported: 1, failed: 0, cancelled: 0, duplicates: 0, photoIds: ['photo-1'] }),
          record: () => ({ id: 'photo-1', contentHash }),
          readOriginal: () => Readable.from(source),
        }),
        /plaintext source bytes remain/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
