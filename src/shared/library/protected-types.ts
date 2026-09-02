import type { PhotoRecord } from './types.js';

/** Renderer-visible protected metadata. Domain equality and library-key
 * fields stay in main even after album authorization. */
export type ProtectedPhotoRecord = Omit<
  PhotoRecord,
  | 'contentHash'
  | 'isOriginal'
  | 'keyId'
  | 'previewFailure'
  | 'dimensionStatus'
  | 'syncState'
  | 'coverage'
  | 'locked'
  | 'derivativeKey'
  | 'variantSourceId'
  | 'assetOwnerId'
>;

export interface ProtectedAlbumOpaqueSummary {
  readonly id: string;
  readonly label: 'Protected album';
  readonly locked: boolean;
}

export interface ProtectedAlbumSummary {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly createdAt: string;
}

export interface ProtectedPageCursor {
  readonly position: number;
  readonly id: string;
}

export interface ProtectedPageRequest {
  readonly albumId: string;
  readonly limit: number;
  readonly cursor?: ProtectedPageCursor | undefined;
  readonly query?: string | undefined;
  readonly source?: 'all' | 'favorites' | 'deleted' | undefined;
}

export interface ProtectedPageResult {
  readonly photos: readonly ProtectedPhotoRecord[];
  readonly nextCursor: ProtectedPageCursor | null;
}
