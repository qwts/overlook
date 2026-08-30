import { Readable } from 'node:stream';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BlobStore } from '../blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import type { PhotosRepository } from '../db/photos-repository.js';
import { extractMetadata, type ExtractedMetadata } from '../import/exif.js';
import type { ThumbnailOutcome, ThumbnailService } from '../import/thumbnail-service.js';
import { queryGet } from '../db/sql.js';
import type { InteropReviewCategory } from '../../shared/interop/contract.js';
import type { FileKind, ImageFileKind, PhotoInsert, PhotoRecord } from '../../shared/library/types.js';
import { probeMediaInfo, sniffImageKind } from '../../shared/library/media-signatures.js';
import type { InteropAlbum, InteropRecord } from '../../shared/interop/records.js';
import type { InteropRepository } from './interop-repository.js';

const extensions: Readonly<Record<ImageFileKind, string>> = {
  jpeg: 'jpg',
  png: 'png',
  heic: 'heic',
  gif: 'gif',
  webp: 'webp',
};

const mimeTypes: Readonly<Record<ImageFileKind, readonly string[]>> = {
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  heic: ['image/heic', 'image/heif'],
  gif: ['image/gif'],
  webp: ['image/webp'],
};

export function deterministicInboundPhotoId(interopId: string): string {
  return `interop-${interopId.toLowerCase()}`;
}

export function inboundFileName(record: InteropRecord, kind: ImageFileKind): string {
  const sanitized = (record.title ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}/\\:]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[ .]+|[ .]+$/gu, '')
    .slice(0, 120)
    .trim();
  const base = sanitized === '' ? `Image Trail capture ${record.identity.interopId.slice(0, 8)}` : sanitized;
  return `${base}.${extensions[kind]}`;
}

export interface InboundPhotoImporterOptions {
  readonly db: BetterSqlite3.Database;
  readonly photos: Pick<PhotosRepository, 'get' | 'insert' | 'repairGeneratedDimensions' | 'setDimensionStatus' | 'setPreviewFailure'>;
  readonly interop: Pick<InteropRepository, 'putRecord' | 'putAlbum'>;
  readonly blobs: Pick<BlobStore, 'putOriginal' | 'verifyOriginal'>;
  readonly currentKey: () => EnvelopeKey;
  readonly resolveKey: KeyResolver;
  readonly thumbnails: Pick<ThumbnailService, 'generateFor'>;
  readonly now?: (() => string) | undefined;
  readonly metadata?: ((bytes: Buffer, kind: FileKind) => Promise<ExtractedMetadata>) | undefined;
}

export interface InboundAcceptanceHooks {
  readonly assertActive?: (() => void) | undefined;
  readonly blobCommitted: () => void;
  readonly databaseCommitted: () => void;
}

export interface InboundAcceptance {
  readonly accepted: boolean;
  readonly reviewCategory: InteropReviewCategory;
  readonly targetLocalId: string | null;
  readonly metadataPersisted: boolean;
  readonly originalVerification: 'verified' | 'metadata-only' | 'unavailable';
  readonly photoChanged: boolean;
  readonly reason: string | null;
}

export class InboundPhotoImporter {
  readonly #now: () => string;
  readonly #metadata: (bytes: Buffer, kind: FileKind) => Promise<ExtractedMetadata>;

  constructor(private readonly options: InboundPhotoImporterOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#metadata = options.metadata ?? extractMetadata;
  }

  acceptWithoutOriginal(
    record: InteropRecord,
    albums: readonly InteropAlbum[],
    category: InteropReviewCategory,
    hooks: Pick<InboundAcceptanceHooks, 'assertActive' | 'databaseCommitted'>,
  ): InboundAcceptance {
    hooks.assertActive?.();
    if (category === 'conflict' || category === 'unsupported' || category === 'skipped') {
      return this.rejected(category, `Incoming record requires ${category} review.`);
    }
    hooks.assertActive?.();
    this.persistInterop(record, albums, category, null);
    hooks.databaseCommitted();
    return {
      accepted: true,
      reviewCategory: category,
      targetLocalId: null,
      metadataPersisted: true,
      originalVerification: record.original.state === 'metadata-only' ? 'metadata-only' : 'unavailable',
      photoChanged: false,
      reason: 'Metadata copied; the source original was retained.',
    };
  }

  async acceptOriginal(
    record: InteropRecord,
    albums: readonly InteropAlbum[],
    category: InteropReviewCategory,
    bytes: Buffer,
    hooks: InboundAcceptanceHooks,
  ): Promise<InboundAcceptance> {
    hooks.assertActive?.();
    if (record.original.state !== 'available') return this.rejected('unsupported', 'Incoming original reference is unavailable.');
    const kind = sniffImageKind(bytes);
    if (kind === null) return this.rejected('unsupported', 'Incoming original media type is unsupported or undetectable.');
    if (!mimeTypes[kind].includes(record.original.mimeType.toLowerCase())) {
      return this.rejected('unsupported', 'Incoming original media type does not match its authenticated content.');
    }
    if (bytes.length !== record.original.byteLength) return this.rejected('unsupported', 'Incoming original byte count does not match.');
    if (category !== 'eligible' && category !== 'duplicate') {
      return this.rejected(category, `Incoming original requires ${category} review.`);
    }

    const duplicateId = queryGet<{ id: string }>(
      this.options.db,
      'SELECT id FROM ordinary_visible_photos WHERE content_hash = ? LIMIT 1',
      record.original.contentHash,
    )?.id;
    const duplicate = duplicateId === undefined ? undefined : this.options.photos.get(duplicateId);
    if (duplicate !== undefined && category === 'duplicate') return this.acceptDuplicate(record, albums, duplicate, hooks);
    if (duplicate !== undefined)
      return this.rejected('conflict', 'A native duplicate appeared after the incoming preview. Refresh and review again.');
    if (category !== 'eligible') return this.rejected(category, `Incoming original requires ${category} review.`);

    const photoId = deterministicInboundPhotoId(record.identity.interopId);
    const existingTarget = this.options.photos.get(photoId);
    let photoChanged = false;
    if (existingTarget === undefined) {
      hooks.assertActive?.();
      const stored = await this.options.blobs.putOriginal(Readable.from([bytes]), this.options.currentKey(), photoId);
      hooks.assertActive?.();
      if (stored.contentHash !== record.original.contentHash || stored.bytes !== record.original.byteLength) {
        return this.rejected('unsupported', 'Incoming original failed its durable content verification.');
      }
      hooks.blobCommitted();
      if (!(await this.options.blobs.verifyOriginal(stored.contentHash, this.options.resolveKey, photoId))) {
        return this.rejected('unsupported', 'Incoming original failed encrypted BlobStore verification.');
      }
      hooks.assertActive?.();
      const metadata = await this.#metadata(bytes, kind);
      hooks.assertActive?.();
      const photo = this.photoInsert(record, kind, photoId, stored.keyId, bytes, metadata);
      this.options.db.transaction(() => {
        this.options.photos.insert(photo);
        this.persistInterop(record, albums, category, photoId);
      })();
      photoChanged = true;
    } else {
      if (existingTarget.contentHash !== record.original.contentHash) {
        return this.rejected('conflict', 'Deterministic target identity is already owned by different content.');
      }
      if (!(await this.options.blobs.verifyOriginal(existingTarget.contentHash, this.options.resolveKey, photoId))) {
        return this.rejected('conflict', 'Existing deterministic target original could not be verified.');
      }
      hooks.assertActive?.();
      this.persistInterop(record, albums, category, photoId);
    }
    hooks.databaseCommitted();
    hooks.assertActive?.();
    const outcome = await this.options.thumbnails.generateFor({
      photoId,
      bytes,
      contentHash: record.original.contentHash,
      key: this.options.currentKey(),
      fileKind: kind,
    });
    this.applyThumbnailOutcome(photoId, kind, outcome);
    return {
      accepted: true,
      reviewCategory: category,
      targetLocalId: photoId,
      metadataPersisted: true,
      originalVerification: 'verified',
      photoChanged,
      reason: null,
    };
  }

  private async acceptDuplicate(
    record: InteropRecord,
    albums: readonly InteropAlbum[],
    duplicate: PhotoRecord,
    hooks: Pick<InboundAcceptanceHooks, 'assertActive' | 'databaseCommitted'>,
  ): Promise<InboundAcceptance> {
    if (!(await this.options.blobs.verifyOriginal(duplicate.contentHash, this.options.resolveKey, duplicate.id))) {
      return this.rejected('conflict', 'Matching native photo custody could not be verified.');
    }
    hooks.assertActive?.();
    this.persistInterop(record, albums, 'duplicate', duplicate.id);
    hooks.databaseCommitted();
    return {
      accepted: true,
      reviewCategory: 'duplicate',
      targetLocalId: duplicate.id,
      metadataPersisted: true,
      originalVerification: 'verified',
      photoChanged: false,
      reason: null,
    };
  }

  private persistInterop(
    record: InteropRecord,
    albums: readonly InteropAlbum[],
    category: InteropReviewCategory,
    photoId: string | null,
  ): void {
    const receivedAt = this.#now();
    this.options.db.transaction(() => {
      this.options.interop.putRecord({ record, reviewCategory: category, receivedAt, localPhotoId: photoId });
      for (const album of albums) this.options.interop.putAlbum({ album, receivedAt });
    })();
  }

  private photoInsert(
    record: InteropRecord,
    kind: ImageFileKind,
    photoId: string,
    keyId: number,
    bytes: Buffer,
    metadata: ExtractedMetadata,
  ): PhotoInsert {
    return {
      id: photoId,
      fileName: inboundFileName(record, kind),
      fileKind: kind,
      mediaInfo: probeMediaInfo(bytes, kind),
      width: metadata.width ?? record.dimensions?.width ?? 0,
      height: metadata.height ?? record.dimensions?.height ?? 0,
      bytes: bytes.length,
      contentHash: record.original.state === 'available' ? record.original.contentHash : '',
      camera: metadata.camera,
      lens: metadata.lens,
      iso: metadata.iso,
      aperture: metadata.aperture,
      shutter: metadata.shutter,
      focalLength: metadata.focalLength,
      takenAt: metadata.takenAt,
      gpsLat: metadata.gpsLat,
      gpsLon: metadata.gpsLon,
      place: null,
      importedAt: this.#now(),
      importSource: 'Image Trail interoperability',
      keyId,
    };
  }

  private applyThumbnailOutcome(photoId: string, kind: FileKind, outcome: ThumbnailOutcome): void {
    if (outcome.width !== null && outcome.height !== null) {
      this.options.photos.repairGeneratedDimensions(photoId, outcome.width, outcome.height);
    } else this.options.photos.setDimensionStatus(photoId, 'unavailable');
    if (kind === 'heic' || kind === 'gif' || kind === 'webp') {
      this.options.photos.setPreviewFailure(photoId, outcome.generated ? null : (outcome.failure ?? 'decode-failed'));
    }
  }

  private rejected(category: InteropReviewCategory, reason: string): InboundAcceptance {
    return {
      accepted: false,
      reviewCategory: category,
      targetLocalId: null,
      metadataPersisted: false,
      originalVerification: 'unavailable',
      photoChanged: false,
      reason,
    };
  }
}
