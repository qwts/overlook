import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { createReleaseImportSmokeRunner, runReleaseImportSmoke } from '../../src/main/release-import-smoke.js';

describe('packaged release import smoke (#1083)', () => {
  test('proves the record, decrypted custody, source preservation, and no plaintext at rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overlook-release-import-smoke-test-'));
    const profile = join(root, 'profile');
    const sourcePath = join(root, 'fixture.jpg');
    const source = Buffer.concat([Buffer.alloc(700, 17), Buffer.from('unique-release-import-smoke-plaintext')]);
    await mkdir(join(profile, 'library'), { recursive: true });
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

  test('rejects plaintext bytes persisted in library custody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overlook-release-import-smoke-test-'));
    const profile = join(root, 'profile');
    const sourcePath = join(root, 'fixture.jpg');
    const source = Buffer.alloc(700, 29);
    await mkdir(join(profile, 'library'), { recursive: true });
    await writeFile(sourcePath, source);
    await writeFile(join(profile, 'library', 'leak.bin'), source);
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

  test('the production runner always closes an opened library after failure', async () => {
    let closed = false;
    const stages: string[] = [];
    const runner = createReleaseImportSmokeRunner(
      () => ({}) as never,
      () => {
        throw new Error('library parts unavailable');
      },
      () => {
        closed = true;
        return Promise.resolve();
      },
      (stage) => stages.push(stage),
    );
    await assert.rejects(runner({ sourcePath: 'fixture.jpg', profilePath: 'profile' }), /library parts unavailable/u);
    assert.equal(closed, true);
    assert.deepEqual(stages, ['bootstrap', 'closing', 'closed']);
  });
});
