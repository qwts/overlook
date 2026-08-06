import type { KeyResolver } from '../crypto/envelope.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { EphemeralOriginalService, type EphemeralStage } from './ephemeral-originals.js';
import type { CustodyHandleResolver } from './custody-handle.js';
import type { SyncLedger } from './sync-ledger.js';
import type { SyncStatus } from '../../shared/library/types.js';

export interface EphemeralRuntimeOptions {
  readonly custody: Pick<CustodyHandleResolver, 'resolve'>;
  readonly ledger: SyncLedger;
  readonly repo: PhotosRepository;
  readonly blobs: BlobStore;
  readonly blobsReady: Promise<void>;
  readonly resolveKey: KeyResolver;
  readonly reOffloadAfterViewing: () => boolean;
  readonly permanentRestore: (photoId: string) => Promise<void>;
  readonly workChanged: (delta: 1 | -1) => void;
  readonly syncStateChanged: (updates: readonly { readonly id: string; readonly syncState: SyncStatus }[]) => void;
  readonly storageChanged: () => void;
  readonly stateChanged: (state: { readonly photoId: string; readonly stage: EphemeralStage }) => void;
  readonly audit: (line: string) => void;
}

export function createEphemeralRuntime(options: EphemeralRuntimeOptions): EphemeralOriginalService {
  return new EphemeralOriginalService({
    custody: options.custody,
    ledger: options.ledger,
    repo: { get: (id) => options.repo.get(id) },
    blobs: {
      hasOriginal: (hash) => options.blobs.hasOriginal(hash),
      durableStream: (hash, photoId) => options.blobs.getStream(hash, options.resolveKey, photoId),
      hasEphemeral: (hash) => options.blobs.hasEphemeralOriginal(hash),
      stageEphemeral: async (hash, ciphertext, photoId) => {
        await options.blobsReady;
        return options.blobs.stageEphemeralOriginal(hash, ciphertext, options.resolveKey, photoId);
      },
      ephemeralStream: (hash, photoId) => options.blobs.getEphemeralStream(hash, options.resolveKey, photoId),
      promoteEphemeral: (hash) => options.blobs.promoteEphemeralOriginal(hash),
      deleteEphemeral: (hash) => options.blobs.deleteEphemeralOriginal(hash),
    },
    reOffloadAfterViewing: options.reOffloadAfterViewing,
    permanentRestore: options.permanentRestore,
    workChanged: options.workChanged,
    syncStateChanged: options.syncStateChanged,
    storageChanged: options.storageChanged,
    stateChanged: options.stateChanged,
    audit: options.audit,
  });
}
