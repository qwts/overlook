import { buffer } from 'node:stream/consumers';
import type { Readable } from 'node:stream';

import type { ProtectedBlobKind, ProtectedBlobStore } from '../blobs/protected-blob-store.js';
import {
  ProtectedAlbumAuthorityError,
  type ProtectedAlbumAuthorityRegistry,
  type ProtectedAlbumAuthoritySnapshot,
} from '../crypto/protected-album-authority.js';
import { openProtectedAlbumMetadata, type ProtectedAlbumMetadata } from '../crypto/protected-album-credentials.js';
import { openProtectedPhotoMetadata, sealProtectedPhotoMetadata, type ProtectedPhotoMetadata } from '../crypto/protected-photo-metadata.js';
import type { ProtectedAlbumRepository } from '../db/protected-album-repository.js';
import type { ProtectedPhotoMigrationRepository, ProtectedPhotoStoredRecord } from '../db/protected-photo-migration-repository.js';
import type {
  ProtectedAlbumOpaqueSummary,
  ProtectedAlbumSummary,
  ProtectedPageRequest,
  ProtectedPageResult,
  ProtectedPhotoRecord,
} from '../../shared/library/protected-types.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import { effectivePhotoTags } from '../../shared/library/photo-metadata.js';

export class ProtectedContentUnavailableError extends Error {
  override readonly name = 'ProtectedContentUnavailableError';
  constructor() {
    super('protected content is unavailable');
  }
}

export interface ProtectedMediaBytes {
  readonly bytes: Buffer;
  /** Opaque, album-scoped reference suitable only for an in-memory ETag. */
  readonly opaqueRef: string;
  readonly fileKind: ProtectedPhotoRecord['fileKind'];
}

export interface ProtectedOriginalSource {
  readonly photo: PhotoRecord;
  readonly stream: Readable;
  readonly release: () => Promise<void>;
}

export interface ProtectedLibraryServiceOptions {
  readonly libraryId: string;
  readonly albums: ProtectedAlbumRepository;
  readonly photos: ProtectedPhotoMigrationRepository;
  readonly blobs: ProtectedBlobStore;
  readonly blobsReady?: Promise<void> | undefined;
  readonly authorities: ProtectedAlbumAuthorityRegistry;
  readonly now?: (() => string) | undefined;
}

interface AuthorizedPhoto {
  readonly snapshot: ProtectedAlbumAuthoritySnapshot;
  readonly record: ProtectedPhotoStoredRecord;
  readonly metadata: ProtectedPhotoMetadata;
}

function visibleMetadata(
  photo: ProtectedPhotoMetadata['photo'],
): Pick<PhotoRecord, 'title' | 'description' | 'tags' | 'userTags' | 'importedKeywords' | 'suppressedKeywords' | 'metadataVersion'> {
  const userTags = photo.userTags ?? [];
  const importedKeywords = photo.importedKeywords ?? [];
  const suppressedKeywords = photo.suppressedKeywords ?? [];
  return {
    title: photo.title ?? null,
    description: photo.description ?? null,
    tags: effectivePhotoTags(importedKeywords, userTags, suppressedKeywords),
    userTags,
    importedKeywords,
    suppressedKeywords,
    metadataVersion: photo.metadataVersion ?? 1,
  };
}

function visiblePhoto(metadata: ProtectedPhotoMetadata): ProtectedPhotoRecord {
  const { contentHash: _contentHash, ...photo } = metadata.photo;
  // mediaInfo is optional in sealed metadata (pre-0026 blobs verify by exact
  // re-stringification, so parsing may not insert keys); records are not.
  // Protected records carry no lineage (#496 keeps Duplicate ordinary).
  return {
    ...photo,
    mediaInfo: photo.mediaInfo ?? null,
    ...visibleMetadata(metadata.photo),
  };
}

function matchesSource(photo: ProtectedPhotoRecord, source: NonNullable<ProtectedPageRequest['source']>): boolean {
  if (source === 'favorites') return photo.deletedAt === null && photo.favorite;
  if (source === 'deleted') return photo.deletedAt !== null;
  return photo.deletedAt === null;
}

function matchesQuery(photo: ProtectedPhotoRecord, query: string): boolean {
  if (query === '') return true;
  return [photo.fileName, photo.title ?? '', photo.description ?? '', photo.place ?? '', photo.camera ?? '', ...photo.tags].some((value) =>
    value.toLowerCase().includes(query),
  );
}

/** Main-process authorization boundary for one protected domain. Every
 * failure is intentionally indistinguishable from locked, missing, corrupt,
 * migrating, or cross-domain content. */
export class ProtectedLibraryService {
  constructor(private readonly options: ProtectedLibraryServiceOptions) {}

  listOpaque(): readonly ProtectedAlbumOpaqueSummary[] {
    return this.options.albums.listOpaque().map(({ albumId }) => ({
      id: albumId,
      label: 'Protected album',
      locked: !this.options.authorities.isAuthorized(albumId),
    }));
  }

  summary(albumId: string): ProtectedAlbumSummary {
    return this.opaque(() => {
      const { snapshot, metadata } = this.album(albumId);
      const records = new Set(this.options.photos.listProtected(albumId).map((record) => record.photoId));
      this.requireCurrent(snapshot);
      return {
        id: albumId,
        name: metadata.name,
        count: metadata.members.filter((member) => records.has(member.photoId)).length,
        createdAt: metadata.createdAt,
      };
    });
  }

  page(request: ProtectedPageRequest): ProtectedPageResult {
    return this.opaque(() => {
      const source = request.source ?? 'all';
      const query = request.query?.toLowerCase() ?? '';
      const { snapshot, metadata } = this.album(request.albumId);
      const ordered = [...metadata.members].sort((a, b) => a.position - b.position || a.photoId.localeCompare(b.photoId));
      const after = request.cursor;
      const matches: { readonly photo: ProtectedPhotoRecord; readonly position: number }[] = [];
      for (const member of ordered) {
        if (
          after !== undefined &&
          (member.position < after.position || (member.position === after.position && member.photoId <= after.id))
        ) {
          continue;
        }
        const authorized = this.photo(request.albumId, member.photoId, snapshot, metadata);
        if (authorized === undefined) continue;
        const photo = visiblePhoto(authorized.metadata);
        if (matchesSource(photo, source) && matchesQuery(photo, query)) matches.push({ photo, position: member.position });
        if (matches.length > request.limit) break;
      }
      this.requireCurrent(snapshot);
      const page = matches.slice(0, request.limit);
      const last = page.at(-1);
      return {
        photos: page.map(({ photo }) => photo),
        nextCursor: matches.length > request.limit && last !== undefined ? { position: last.position, id: last.photo.id } : null,
      };
    });
  }

  get(albumId: string, photoId: string): ProtectedPhotoRecord {
    return this.opaque(() => visiblePhoto(this.requirePhoto(albumId, photoId).metadata));
  }

  isAuthorizedPhoto(albumId: string, photoId: string): boolean {
    try {
      this.requirePhoto(albumId, photoId);
      return true;
    } catch {
      return false;
    }
  }

  toggleFavorite(albumId: string, photoId: string): { readonly favorite: boolean } {
    const changed = this.mutate(albumId, photoId, (metadata) => ({
      ...metadata,
      photo: { ...metadata.photo, favorite: !metadata.photo.favorite },
    }));
    return { favorite: changed.photo.favorite };
  }

  softDelete(albumId: string, photoIds: readonly string[]): { readonly deleted: number } {
    return this.opaque(() => {
      let deleted = 0;
      for (const photoId of photoIds) {
        const current = this.requirePhoto(albumId, photoId);
        if (current.metadata.photo.deletedAt !== null) continue;
        this.mutate(albumId, photoId, (metadata) => ({
          ...metadata,
          photo: { ...metadata.photo, deletedAt: this.options.now?.() ?? new Date().toISOString() },
        }));
        deleted += 1;
      }
      return { deleted };
    });
  }

  restore(albumId: string, photoIds: readonly string[]): { readonly restored: number } {
    return this.opaque(() => {
      let restored = 0;
      for (const photoId of photoIds) {
        const current = this.requirePhoto(albumId, photoId);
        if (current.metadata.photo.deletedAt === null) continue;
        this.mutate(albumId, photoId, (metadata) => ({ ...metadata, photo: { ...metadata.photo, deletedAt: null } }));
        restored += 1;
      }
      return { restored };
    });
  }

  async media(albumId: string, photoId: string, kind: ProtectedBlobKind): Promise<ProtectedMediaBytes> {
    try {
      const authorized = this.requirePhoto(albumId, photoId);
      await this.options.blobsReady;
      const bytes = await this.options.authorities.withSnapshot(authorized.snapshot, (albumKey) =>
        buffer(this.options.blobs.getStream(albumId, authorized.record.blobRef, kind, albumKey)),
      );
      if (!this.options.authorities.isCurrent(authorized.snapshot)) {
        bytes.fill(0);
        throw new ProtectedContentUnavailableError();
      }
      return {
        bytes,
        opaqueRef: authorized.record.blobRef,
        fileKind: authorized.metadata.photo.fileKind,
      };
    } catch {
      throw new ProtectedContentUnavailableError();
    }
  }

  exportPhoto(albumId: string, photoId: string): PhotoRecord {
    return this.opaque(() => {
      const metadata = this.requirePhoto(albumId, photoId).metadata.photo;
      return {
        ...metadata,
        derivativeKey: metadata.contentHash,
        variantSourceId: null,
        assetOwnerId: null,
        mediaInfo: metadata.mediaInfo ?? null,
        ...visibleMetadata(metadata),
        isOriginal: false,
        keyId: 1,
        previewFailure: null,
        dimensionStatus: 'verified',
        syncState: 'local',
        coverage: 'included',
        locked: false,
      };
    });
  }

  openOriginal(albumId: string, photoId: string): ProtectedOriginalSource {
    return this.opaque(() => {
      const authorized = this.requirePhoto(albumId, photoId);
      const stream = this.options.authorities.withSnapshot(authorized.snapshot, (albumKey) =>
        this.options.blobs.getStream(albumId, authorized.record.blobRef, 'original', albumKey),
      );
      let released = false;
      const stopRevocation = this.options.authorities.onRevoked((revokedAlbumId) => {
        if (revokedAlbumId === albumId && !this.options.authorities.isCurrent(authorized.snapshot)) {
          stream.destroy(new ProtectedContentUnavailableError());
        }
      });
      const release = (): Promise<void> => {
        if (released) return Promise.resolve();
        released = true;
        stopRevocation();
        if (!stream.destroyed) stream.destroy();
        return Promise.resolve();
      };
      stream.once('close', stopRevocation);
      return {
        photo: {
          ...authorized.metadata.photo,
          derivativeKey: authorized.metadata.photo.contentHash,
          variantSourceId: null,
          assetOwnerId: null,
          mediaInfo: authorized.metadata.photo.mediaInfo ?? null,
          ...visibleMetadata(authorized.metadata.photo),
          isOriginal: false,
          keyId: 1,
          previewFailure: null,
          dimensionStatus: 'verified',
          syncState: 'local',
          coverage: 'included',
          locked: false,
        },
        stream,
        release,
      };
    });
  }

  private mutate(
    albumId: string,
    photoId: string,
    update: (metadata: ProtectedPhotoMetadata) => ProtectedPhotoMetadata,
  ): ProtectedPhotoMetadata {
    return this.opaque(() => {
      const authorized = this.requirePhoto(albumId, photoId);
      const next = update(authorized.metadata);
      const sealedMetadata = this.options.authorities.withSnapshot(authorized.snapshot, (albumKey) =>
        sealProtectedPhotoMetadata({ libraryId: this.options.libraryId, albumId, photoId }, albumKey, next),
      );
      if (
        !this.options.photos.replaceMetadata({
          albumId,
          photoId,
          expected: authorized.record.sealedMetadata,
          sealedMetadata,
          ...(this.options.now === undefined ? {} : { now: this.options.now() }),
        })
      ) {
        throw new ProtectedContentUnavailableError();
      }
      this.requireCurrent(authorized.snapshot);
      return next;
    });
  }

  private requirePhoto(albumId: string, photoId: string): AuthorizedPhoto {
    const { snapshot, metadata } = this.album(albumId);
    const authorized = this.photo(albumId, photoId, snapshot, metadata);
    if (authorized === undefined) throw new ProtectedContentUnavailableError();
    return authorized;
  }

  private photo(
    albumId: string,
    photoId: string,
    snapshot: ProtectedAlbumAuthoritySnapshot,
    albumMetadata: ProtectedAlbumMetadata,
  ): AuthorizedPhoto | undefined {
    if (!albumMetadata.members.some((member) => member.photoId === photoId)) return undefined;
    const record = this.options.photos.getProtected(photoId);
    if (record === undefined || record.albumId !== albumId) return undefined;
    const metadata = this.options.authorities.withSnapshot(snapshot, (albumKey) =>
      openProtectedPhotoMetadata({ libraryId: this.options.libraryId, albumId, photoId }, albumKey, record.sealedMetadata),
    );
    this.requireCurrent(snapshot);
    return { snapshot, record, metadata };
  }

  private album(albumId: string): { readonly snapshot: ProtectedAlbumAuthoritySnapshot; readonly metadata: ProtectedAlbumMetadata } {
    const snapshot = this.options.authorities.snapshot(albumId);
    const stored = this.options.albums.get(albumId);
    if (stored === undefined) throw new ProtectedContentUnavailableError();
    const metadata = this.options.authorities.withSnapshot(snapshot, (albumKey) =>
      openProtectedAlbumMetadata({ libraryId: this.options.libraryId, albumId }, albumKey, stored.credentialRecord, stored.sealedMetadata),
    );
    this.requireCurrent(snapshot);
    return { snapshot, metadata };
  }

  private requireCurrent(snapshot: ProtectedAlbumAuthoritySnapshot): void {
    if (!this.options.authorities.isCurrent(snapshot)) throw new ProtectedContentUnavailableError();
  }

  private opaque<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ProtectedContentUnavailableError) throw error;
      if (error instanceof ProtectedAlbumAuthorityError) throw new ProtectedContentUnavailableError();
      throw new ProtectedContentUnavailableError();
    }
  }
}
