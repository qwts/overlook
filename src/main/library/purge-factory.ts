import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { createPurgeRepository, PurgeService, type PurgeDeps } from './purge-service.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { BlobStore } from '../blobs/blob-store.js';

// Purge composition, extracted from the composition root (index.ts sits at
// the 800-line budget): the repo/blob seams are mechanical; policy deps
// (provider, retention, audit) stay with the caller.

export interface PurgeFactoryDeps {
  readonly db: BetterSqlite3.Database;
  readonly repo: PhotosRepository;
  readonly blobStore: BlobStore;
  readonly remoteProvider: PurgeDeps['remoteProvider'];
  readonly oweManifest: PurgeDeps['oweManifest'];
  readonly libraryChanged: PurgeDeps['libraryChanged'];
  readonly audit: PurgeDeps['audit'];
  readonly retention: PurgeDeps['retention'];
}

export function createPurgeService(deps: PurgeFactoryDeps): PurgeService {
  return new PurgeService({
    repo: createPurgeRepository(deps.repo, new SidecarRepository(deps.db)),
    blobs: {
      deleteOriginal: async (hash) => deps.blobStore.deleteOriginal(hash),
      deleteThumbs: async (hash) => deps.blobStore.deleteThumbs(hash),
      deleteSidecars: async (photoId) => deps.blobStore.deleteSidecars(photoId),
    },
    remoteProvider: deps.remoteProvider,
    oweManifest: deps.oweManifest,
    libraryChanged: deps.libraryChanged,
    audit: deps.audit,
    retention: deps.retention,
    now: () => Date.now(),
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
