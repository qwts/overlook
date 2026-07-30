import { existsSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { SidecarRepository } from '../db/sidecar-repository.js';
import { extractMetadata } from './exif.js';
import { ImportEngine, type ImportSummary } from './import-engine.js';
import { ImportJournal } from './import-journal.js';
import { ImportService, type ImportServiceEvents } from './import-service.js';
import { ThumbnailPool } from './thumbnail-pool.js';
import { ThumbnailService } from './thumbnail-service.js';
import { ulid } from './ulid.js';
import type { GoogleDriveImportSource } from './google-drive-source.js';

export { createDriveImport } from './google-drive-source-runtime.js';
export type { ImportService } from './import-service.js';

export interface ImportRuntimeOptions {
  readonly dataDir: string;
  readonly workerUrl: URL;
  readonly repo: PhotosRepository;
  readonly sidecars: SidecarRepository;
  readonly blobs: BlobStore;
  readonly blobsReady: Promise<void>;
  readonly currentKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  readonly events: ImportServiceEvents;
  readonly fixtureSource: () => string | undefined;
  readonly resumed: (summary: ImportSummary) => void;
  readonly googleDrive: GoogleDriveImportSource;
}

export interface ImportRuntime {
  readonly service: ImportService;
  readonly pool: ThumbnailPool;
  readonly thumbnails: ThumbnailService;
}

export function createImportRuntime(options: ImportRuntimeOptions): ImportRuntime {
  const pool = new ThumbnailPool({ workerUrl: options.workerUrl });
  const thumbnails = new ThumbnailService(pool, options.blobs);
  const journal = new ImportJournal(join(options.dataDir, 'import-journal.json'));
  const engine = new ImportEngine({
    readFile: async (filePath) => readFile(filePath),
    deleteFile: async (filePath) => unlink(filePath),
    journal,
    repo: {
      hasContentHash: (hash) => options.repo.hasContentHash(hash),
      get: (id) => options.repo.get(id),
      insert: (photo) => options.repo.insert(photo),
      insertSidecar: (record) => options.sidecars.insert(record),
      repairGeneratedDimensions: (id, width, height) => options.repo.repairGeneratedDimensions(id, width, height),
      setDimensionStatus: (id, status) => options.repo.setDimensionStatus(id, status),
      setPreviewFailure: (id, failure) => options.repo.setPreviewFailure(id, failure),
    },
    blobs: {
      putOriginal: async (plaintext, key, photoId) => {
        await options.blobsReady;
        return options.blobs.putOriginal(plaintext, key, photoId);
      },
      verifyOriginal: async (contentHash, resolveKey, photoId) => options.blobs.verifyOriginal(contentHash, resolveKey, photoId),
      putSidecar: async (plaintext, key, photoId) => {
        await options.blobsReady;
        return options.blobs.putSidecar(plaintext, key, photoId);
      },
      verifySidecar: async (photoId, contentHash, resolveKey) => options.blobs.verifySidecar(photoId, contentHash, resolveKey),
    },
    generateThumbs: async (request) => {
      await options.blobsReady;
      return thumbnails.generateFor(request);
    },
    extractMetadata,
    currentKey: options.currentKey,
    resolveKey: options.resolveKey,
    newId: ulid,
    now: () => new Date().toISOString(),
    events: options.events,
    cleanupSource: (path) => options.googleDrive.cleanupRoot(path),
    sourceExists: existsSync,
    parentIdentity: async (path) => {
      const info = await stat(dirname(path));
      return `${info.dev}:${info.ino}`;
    },
  });
  const service = new ImportService(
    options.repo,
    options.events,
    engine,
    options.fixtureSource,
    undefined,
    options.googleDrive,
    options.dataDir,
  );
  void journal
    .read()
    .then(async (manifest) => {
      await options.googleDrive.cleanupOrphans(manifest?.cleanupPath ?? null);
      return service.resume();
    })
    .then((summary) => {
      if (summary !== null && summary.imported > 0) options.resumed(summary);
    })
    .catch((error: unknown) => {
      console.error('[overlook] import resume failed', error);
    });
  return { service, pool, thumbnails };
}
