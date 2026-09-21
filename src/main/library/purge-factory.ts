import { PurgeCleanupRepository } from './purge-cleanup-repository.js';
import { PurgeCleanupService, type PurgeCleanupDeps } from './purge-cleanup-service.js';
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
  readonly cleanup: Pick<PurgeCleanupService, 'transfer'>;
  readonly remoteProvider: PurgeDeps['remoteProvider'];
  readonly custodyChanged: PurgeDeps['custodyChanged'];
  readonly oweManifest: PurgeDeps['oweManifest'];
  readonly libraryChanged: PurgeDeps['libraryChanged'];
  readonly audit: PurgeDeps['audit'];
  readonly retention: PurgeDeps['retention'];
}

export function createPurgeService(deps: PurgeFactoryDeps): PurgeService {
  return new PurgeService({
    repo: createPurgeRepository(deps.repo, new SidecarRepository(deps.db)),
    purgeExcluding: (photoId, authorized) =>
      deps.cleanup.transfer(photoId, () => {
        if (authorized) deps.repo.purgeRowAuthorized(photoId);
        else deps.repo.purgeRow(photoId);
      }),
    blobs: {
      deleteOriginal: async (hash) => deps.blobStore.deleteOriginal(hash),
      deleteThumbs: async (hash) => deps.blobStore.deleteThumbs(hash),
      deleteSidecars: async (photoId) => deps.blobStore.deleteSidecars(photoId),
    },
    remoteProvider: deps.remoteProvider,
    custodyChanged: deps.custodyChanged,
    oweManifest: deps.oweManifest,
    libraryChanged: deps.libraryChanged,
    audit: deps.audit,
    retention: deps.retention,
    now: () => Date.now(),
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

export function createPurgeCleanup(db: BetterSqlite3.Database, deps: Omit<PurgeCleanupDeps, 'repo'>): PurgeCleanupService {
  return new PurgeCleanupService({ ...deps, repo: new PurgeCleanupRepository(db) });
}

export function createRoutedPurgeCleanup(
  db: BetterSqlite3.Database,
  routing: Pick<PurgeCleanupDeps, 'authorities' | 'captureAuthority' | 'ensureTargetAuthority'> & {
    readonly resolver: PurgeCleanupDeps['custody'];
  },
  audit: PurgeCleanupDeps['audit'],
): PurgeCleanupService {
  return createPurgeCleanup(db, { ...routing, custody: routing.resolver, audit });
}
