import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { ProtectedBlobKind } from '../blobs/protected-blob-store.js';
import type {
  BackupManifestV3,
  BackupManifestV4,
  BackupManifestV5,
  BackupManifestV6,
  BackupManifestV7,
  BackupManifestV8,
  BackupManifestV9,
  BackupManifestV10,
  BackupManifestV11,
  BackupManifestV12,
  BackupManifestV13,
  BackupManifestV14,
  ProtectedBackupAlbumV3,
  ProtectedBackupObjectV3,
  ProtectedBackupPhotoV3,
} from '../backup/backup-manifest.js';
import { protectedObjectPath } from '../backup/protected-object-path.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';

export type ProtectedRemoteStatus = 'local' | 'synced' | 'offloaded' | 'error';

export interface ProtectedRemoteObject {
  readonly photoId: string;
  readonly albumId: string;
  readonly blobRef: string;
  readonly kind: ProtectedBlobKind;
  readonly status: ProtectedRemoteStatus;
  readonly dirty: boolean;
  readonly sha256: string | null;
  readonly bytes: number | null;
}

interface RemoteRow {
  readonly photoId: string;
  readonly albumId: string;
  readonly blobRef: string;
  readonly kind: ProtectedBlobKind;
  readonly status: ProtectedRemoteStatus;
  readonly dirty: number;
  readonly sha256: string | null;
  readonly bytes: number | null;
}

interface AlbumRow {
  readonly id: string;
  readonly credentialGeneration: number;
  readonly metadataGeneration: number;
  readonly credentialRecord: Buffer;
  readonly sealedMetadata: Buffer;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PhotoRow {
  readonly id: string;
  readonly albumId: string;
  readonly blobRef: string;
  readonly sealedMetadata: Buffer;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function remote(row: RemoteRow): ProtectedRemoteObject {
  return { ...row, dirty: row.dirty === 1 };
}

export class ProtectedRecoveryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  dirtyObjects(): readonly ProtectedRemoteObject[] {
    return this.remoteRows(
      `WHERE object.dirty = 1 AND object.status <> 'offloaded'
         AND NOT EXISTS (SELECT 1 FROM protected_photo_migration_items item WHERE item.photo_id = object.photo_id)
       ORDER BY object.photo_id, object.kind`,
    ).map(remote);
  }

  objects(photoId: string): readonly ProtectedRemoteObject[] {
    return this.remoteRows('WHERE object.photo_id = @photoId ORDER BY object.kind', { photoId }).map(remote);
  }

  recoverableObjects(): readonly ProtectedRemoteObject[] {
    return this.remoteRows(
      `WHERE object.status IN ('synced', 'offloaded') AND object.dirty = 0
         AND object.ciphertext_sha256 IS NOT NULL AND object.ciphertext_bytes IS NOT NULL
       ORDER BY object.photo_id, object.kind`,
    ).map(remote);
  }

  /** Every protected remote-copy claim plus stuck 'error' rows a wrong
   * provider's integrity pass may have produced — the provider-switch
   * guard's and manifest preflight's worklist (#741). */
  remoteClaims(): readonly ProtectedRemoteObject[] {
    return this.remoteRows(`WHERE object.status IN ('synced', 'offloaded', 'error') ORDER BY object.photo_id, object.kind`).map(remote);
  }

  /** Re-queues an object the selected provider is missing while its
   * ciphertext is still local (#741): dirty flows it back through the
   * normal verified upload path for the selected provider. */
  requeue(item: ProtectedRemoteObject): void {
    runNamed(this.db, `UPDATE protected_remote_objects SET dirty = 1 WHERE photo_id = @photoId AND kind = @kind`, {
      photoId: item.photoId,
      kind: item.kind,
    });
  }

  /** Heals a remote-only object a wrong provider's scrub marked 'error'
   * (#741) once the switch guard proves the connecting provider holds its
   * ciphertext: back to a clean offloaded claim. */
  healRemote(item: ProtectedRemoteObject): void {
    runNamed(
      this.db,
      `UPDATE protected_remote_objects SET status = 'offloaded', dirty = 0
        WHERE photo_id = @photoId AND kind = @kind`,
      { photoId: item.photoId, kind: item.kind },
    );
  }

  hasManifestDebt(): boolean {
    return (
      queryGet<{ one: number }>(
        this.db,
        `SELECT 1 AS one FROM protected_album_records WHERE manifest_dirty = 1
         UNION ALL SELECT 1 FROM protected_photo_records WHERE manifest_dirty = 1
         UNION ALL SELECT 1 FROM protected_remote_objects WHERE dirty = 1
         LIMIT 1`,
      ) !== undefined
    );
  }

  markBackedUp(item: ProtectedRemoteObject, sha256: string, bytes: number, at: string): void {
    const changed = queryGet<{ photoId: string }>(
      this.db,
      `UPDATE protected_remote_objects
          SET status = 'synced', dirty = 0, ciphertext_sha256 = @sha256,
              ciphertext_bytes = @bytes, last_backup_at = @at
        WHERE photo_id = @photoId AND kind = @kind
        RETURNING photo_id AS photoId`,
      { photoId: item.photoId, kind: item.kind, sha256, bytes, at },
    );
    if (changed === undefined) throw new Error('protected remote object disappeared during backup');
  }

  markError(item: ProtectedRemoteObject): void {
    runNamed(
      this.db,
      `UPDATE protected_remote_objects SET status = 'error', dirty = 1
        WHERE photo_id = @photoId AND kind = @kind`,
      { photoId: item.photoId, kind: item.kind },
    );
  }

  markOffloaded(photoId: string): void {
    run(this.db, `UPDATE protected_remote_objects SET status = 'offloaded', dirty = 0 WHERE photo_id = ?`, photoId);
  }

  markRehydrated(photoId: string): void {
    run(this.db, `UPDATE protected_remote_objects SET status = 'synced', dirty = 0 WHERE photo_id = ?`, photoId);
  }

  snapshot(): { readonly protectedAlbums: readonly ProtectedBackupAlbumV3[]; readonly protectedPhotos: readonly ProtectedBackupPhotoV3[] } {
    const protectedAlbums = queryAll<AlbumRow>(
      this.db,
      `SELECT album_id AS id, credential_generation AS credentialGeneration,
              metadata_generation AS metadataGeneration, credential_record AS credentialRecord,
              sealed_metadata AS sealedMetadata, created_at AS createdAt, updated_at AS updatedAt
         FROM protected_album_records WHERE migration_state = 'active' ORDER BY album_id`,
    ).map((row): ProtectedBackupAlbumV3 => ({
      ...row,
      credentialRecord: row.credentialRecord.toString('base64'),
      sealedMetadata: row.sealedMetadata.toString('base64'),
    }));
    const activeAlbums = new Set(protectedAlbums.map((album) => album.id));
    const protectedPhotos = queryAll<PhotoRow>(
      this.db,
      `SELECT photo_id AS id, album_id AS albumId, blob_ref AS blobRef,
              sealed_metadata AS sealedMetadata, created_at AS createdAt, updated_at AS updatedAt
         FROM protected_photo_records photo
        WHERE NOT EXISTS (SELECT 1 FROM protected_photo_migration_items item WHERE item.photo_id = photo.photo_id)
          AND NOT EXISTS (
            SELECT 1 FROM protected_remote_objects object
             WHERE object.photo_id = photo.photo_id
               AND (object.status NOT IN ('synced', 'offloaded') OR object.dirty = 1 OR object.ciphertext_sha256 IS NULL)
          )
        ORDER BY photo_id`,
    )
      .filter((photo) => activeAlbums.has(photo.albumId))
      .map((photo): ProtectedBackupPhotoV3 => ({
        ...photo,
        sealedMetadata: photo.sealedMetadata.toString('base64'),
        objects: this.objects(photo.id).map((object): ProtectedBackupObjectV3 => {
          if (object.sha256 === null || object.bytes === null || (object.status !== 'synced' && object.status !== 'offloaded')) {
            throw new Error('protected manifest snapshot contains an unverified object');
          }
          return {
            kind: object.kind,
            path: protectedObjectPath(photo.blobRef, object.kind),
            sha256: object.sha256,
            bytes: object.bytes,
            status: object.status,
          };
        }),
      }));
    return { protectedAlbums, protectedPhotos };
  }

  settleManifest(snapshot: {
    readonly protectedAlbums: readonly ProtectedBackupAlbumV3[];
    readonly protectedPhotos: readonly ProtectedBackupPhotoV3[];
  }): void {
    this.db.transaction(() => {
      for (const album of snapshot.protectedAlbums) {
        runNamed(
          this.db,
          `UPDATE protected_album_records SET manifest_dirty = 0
            WHERE album_id = @id AND credential_record = @credentialRecord AND sealed_metadata = @sealedMetadata`,
          {
            id: album.id,
            credentialRecord: Buffer.from(album.credentialRecord, 'base64'),
            sealedMetadata: Buffer.from(album.sealedMetadata, 'base64'),
          },
        );
      }
      for (const photo of snapshot.protectedPhotos) {
        runNamed(
          this.db,
          `UPDATE protected_photo_records SET manifest_dirty = 0
            WHERE photo_id = @id AND sealed_metadata = @sealedMetadata`,
          { id: photo.id, sealedMetadata: Buffer.from(photo.sealedMetadata, 'base64') },
        );
      }
    })();
  }

  restore(
    manifest:
      | BackupManifestV3
      | BackupManifestV4
      | BackupManifestV5
      | BackupManifestV6
      | BackupManifestV7
      | BackupManifestV8
      | BackupManifestV9
      | BackupManifestV10
      | BackupManifestV11
      | BackupManifestV12
      | BackupManifestV13
      | BackupManifestV14,
  ): void {
    this.db.transaction(() => {
      for (const album of manifest.protectedAlbums) {
        runNamed(
          this.db,
          `INSERT INTO protected_album_records (
             album_id, record_version, migration_state, credential_generation, metadata_generation,
             credential_record, sealed_metadata, created_at, updated_at, manifest_dirty
           ) VALUES (@id, 1, 'active', @credentialGeneration, @metadataGeneration,
             @credentialRecord, @sealedMetadata, @createdAt, @updatedAt, 0)`,
          {
            ...album,
            credentialRecord: Buffer.from(album.credentialRecord, 'base64'),
            sealedMetadata: Buffer.from(album.sealedMetadata, 'base64'),
          },
        );
      }
      for (const photo of manifest.protectedPhotos) {
        const kinds = new Set(photo.objects.map((object) => object.kind));
        runNamed(
          this.db,
          `INSERT INTO protected_photo_records (
             photo_id, album_id, record_version, blob_ref, sealed_metadata,
             has_thumb, has_mid, created_at, updated_at, manifest_dirty
           ) VALUES (@id, @albumId, 1, @blobRef, @sealedMetadata,
             @hasThumb, @hasMid, @createdAt, @updatedAt, 0)`,
          {
            ...photo,
            sealedMetadata: Buffer.from(photo.sealedMetadata, 'base64'),
            hasThumb: kinds.has('thumb') ? 1 : 0,
            hasMid: kinds.has('mid') ? 1 : 0,
          },
        );
        for (const object of photo.objects) {
          runNamed(
            this.db,
            `INSERT INTO protected_remote_objects (
               photo_id, kind, status, dirty, ciphertext_sha256, ciphertext_bytes, last_backup_at
             ) VALUES (@photoId, @kind, @status, 0, @sha256, @bytes, @at)`,
            { photoId: photo.id, ...object, at: manifest.generatedAt },
          );
        }
      }
    })();
  }

  private remoteRows(where: string, params?: Record<string, unknown>): readonly RemoteRow[] {
    return queryAll<RemoteRow>(
      this.db,
      `SELECT object.photo_id AS photoId, photo.album_id AS albumId, photo.blob_ref AS blobRef,
              object.kind, object.status, object.dirty,
              object.ciphertext_sha256 AS sha256, object.ciphertext_bytes AS bytes
         FROM protected_remote_objects object
         JOIN protected_photo_records photo ON photo.photo_id = object.photo_id
         ${where}`,
      params,
    );
  }
}
