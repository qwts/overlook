import { sidecarOwnerOf } from '../../shared/library/sidecar-files.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { ConsistencyChecker, type ConsistencyDeps } from './consistency.js';
import { OriginalAvailabilityRepository } from '../db/original-availability.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { StorageProvider } from '../backup/provider.js';

// Consistency-scan composition, extracted from the composition root
// (index.ts sits at the 800-line budget): the repo/blob seams are
// mechanical; presentation deps (events and audit) stay with the
// caller.

export interface ConsistencyFactoryDeps {
  readonly db: BetterSqlite3.Database;
  readonly repo: PhotosRepository;
  readonly blobStore: BlobStore;
  readonly provider: StorageProvider;
  readonly libraryChanged: ConsistencyDeps['libraryChanged'];
  readonly audit: ConsistencyDeps['audit'];
}

export function createConsistencyChecker(deps: ConsistencyFactoryDeps): ConsistencyChecker {
  return new ConsistencyChecker({
    rows: () => deps.repo.allRows(),
    ownedSidecars: () =>
      new SidecarRepository(deps.db).allRows().map((row) => ({ photoId: sidecarOwnerOf(row), contentHash: row.contentHash })),
    hiddenOwnedHashes: () => deps.repo.migrationOwnedContentHashes(),
    blobs: {
      listOriginalHashes: async () => deps.blobStore.listOriginalHashes(),
      listThumbHashes: async () => deps.blobStore.listThumbHashes(),
      listSidecarEntries: async () => deps.blobStore.listSidecarEntries(),
      listStaged: async () => deps.blobStore.listStaged(),
      hasOriginal: (hash) => deps.blobStore.hasOriginal(hash),
      deleteOriginal: async (hash) => deps.blobStore.deleteOriginal(hash),
      deleteThumbs: async (hash) => deps.blobStore.deleteThumbs(hash),
      deleteSidecars: async (photoId) => deps.blobStore.deleteSidecars(photoId),
      removeStaged: async (name) => deps.blobStore.removeStaged(name),
    },
    remoteHas: async (hash) => {
      try {
        await deps.provider.verify(`blobs/${hash.slice(0, 2)}/${hash}`);
        return true;
      } catch {
        return false;
      }
    },
    setStatus: (photoId, status) => new OriginalAvailabilityRepository(deps.db).repair(photoId, status),
    libraryChanged: deps.libraryChanged,
    audit: deps.audit,
  });
}
