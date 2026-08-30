import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { PhotosRepository } from './db/photos-repository.js';
import type { ImportService } from './import/import-runtime.js';
import type { LibraryParts } from './library/library-parts.js';
import type { ReleaseImportSmokeRequest } from './release-smoke.js';

interface ImportSmokeSummary {
  readonly imported: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly duplicates: number;
  readonly photoIds: readonly string[];
}

interface ImportSmokeRecord {
  readonly id: string;
  readonly contentHash: string;
}

export interface ReleaseImportSmokeDependencies {
  readonly runCopy: (sourcePath: string) => Promise<ImportSmokeSummary>;
  readonly record: (photoId: string) => ImportSmokeRecord | undefined;
  readonly readOriginal: (record: ImportSmokeRecord) => Readable;
}

async function containsBytes(directory: string, needle: Buffer): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsBytes(path, needle)) return true;
    } else if (entry.isFile()) {
      if ((await readFile(path)).includes(needle)) return true;
    }
  }
  return false;
}

export async function runReleaseImportSmoke(
  sourcePath: string,
  profilePath: string,
  dependencies: ReleaseImportSmokeDependencies,
): Promise<void> {
  const source = await readFile(sourcePath);
  const expectedHash = createHash('sha256').update(source).digest('hex');
  const summary = await dependencies.runCopy(sourcePath);
  if (
    summary.imported !== 1 ||
    summary.failed !== 0 ||
    summary.cancelled !== 0 ||
    summary.duplicates !== 0 ||
    summary.photoIds.length !== 1
  ) {
    throw new Error(`unexpected import summary: ${JSON.stringify(summary)}`);
  }
  const photoId = summary.photoIds[0];
  if (photoId === undefined) throw new Error('import did not return a photo id');
  const record = dependencies.record(photoId);
  if (record === undefined || record.id !== photoId) throw new Error('imported photo record is missing');
  if (record.contentHash !== expectedHash) throw new Error('imported photo hash does not match the source');
  const decrypted = await buffer(dependencies.readOriginal(record));
  if (!decrypted.equals(source)) throw new Error('decrypted library original does not match the source');
  const persistedSource = await readFile(sourcePath);
  if (!persistedSource.equals(source)) throw new Error('copy import changed the source fixture');
  const needle = source.subarray(Math.min(600, Math.max(0, source.length - 40)), Math.min(source.length, 640));
  if (needle.length > 0 && (await containsBytes(join(profilePath, 'library'), needle))) {
    throw new Error('plaintext source bytes remain in the isolated library custody');
  }
}

export function createReleaseImportSmokeRunner(
  getImportService: () => ImportService,
  requireParts: (what: string) => LibraryParts,
  closeLibrary: () => Promise<void> | undefined,
  report: (stage: string) => void = () => undefined,
): (request: ReleaseImportSmokeRequest) => Promise<void> {
  return async ({ sourcePath, profilePath }) => {
    try {
      report('bootstrap');
      const service = getImportService();
      const parts = requireParts('release import smoke');
      report('library-open');
      await parts.blobStoreReady;
      report('storage-ready');
      const repo = new PhotosRepository(parts.db);
      await runReleaseImportSmoke(sourcePath, profilePath, {
        runCopy: (path) => service.runFiles([path], 'copy'),
        record: (photoId) => repo.get(photoId),
        readOriginal: (record) => parts.blobStore.getStream(record.contentHash, parts.keyStore.resolver(), record.id),
      });
      report('verified');
    } finally {
      report('closing');
      await closeLibrary();
      report('closed');
    }
  };
}
