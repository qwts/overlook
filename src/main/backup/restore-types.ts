import { ProviderError } from './provider.js';
import type { RestoreFailure } from '../../shared/backup/restore-contract.js';

export type { RestoreFailure } from '../../shared/backup/restore-contract.js';

export class RestoreError extends Error {
  override readonly name = 'RestoreError';

  constructor(
    readonly reason: RestoreFailure,
    message: string,
  ) {
    super(message);
  }
}

export type RestoreStage = 'discovering' | 'downloading' | 'rebuilding' | 'activating' | 'complete';

export interface RestoreProgress {
  readonly stage: RestoreStage;
  readonly done: number;
  readonly total: number;
  readonly photoId: string | null;
}

export interface RestoreCheckpoint {
  readonly version: 1;
  readonly libraryId: string;
  readonly manifestPath: string;
  readonly sealedManifestSha256: string;
  readonly completedBlobIds: readonly string[];
  readonly completedThumbnailIds: readonly string[];
  readonly completedProtectedObjectIds: readonly string[];
  /** Sidecar objects already restored + verified (#484): `photoId:hash`.
   * Optional for checkpoints written before schema-6 manifests. */
  readonly completedSidecarIds?: readonly string[] | undefined;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'restore cancelled');
}

export function toRestoreError(error: unknown): RestoreError {
  if (error instanceof RestoreError) return error;
  if (isAbortError(error)) return new RestoreError('cancelled', 'restore cancelled');
  if (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === 'ENOSPC' || (error as NodeJS.ErrnoException).code === 'EDQUOT')
  ) {
    return new RestoreError('disk-space', error.message);
  }
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case 'auth':
        return new RestoreError('auth', error.message);
      case 'transient':
        return new RestoreError(error.scope === 'object' ? 'io' : 'offline', error.message);
      case 'quota':
        return new RestoreError('disk-space', error.message);
      case 'not-found':
      case 'corrupt':
        return new RestoreError('corrupt', error.message);
    }
  }
  return new RestoreError('io', error instanceof Error ? error.message : String(error));
}
