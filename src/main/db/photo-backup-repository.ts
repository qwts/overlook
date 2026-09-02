import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BackupManifestPhotoV13, BackupManifestSnapshot, RestorableBackupManifest } from '../backup/backup-manifest.js';
import type { WrappedKeyRecord } from '../crypto/keystore.js';
import { queryAll, queryGet, run, runNamed } from './sql.js';
import { select } from './photo-query.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { PhotoRow } from './photos-repository.js';

function mediaInfoJson(mediaInfo: unknown): string | null {
  return mediaInfo === null || mediaInfo === undefined ? null : JSON.stringify(mediaInfo);
}

export function manifestSnapshot(db: BetterSqlite3.Database, toRecord: (row: PhotoRow) => PhotoRecord): BackupManifestSnapshot {
  return db.transaction(() => {
    const recoverable = `(p.deleted_at IS NULL OR (p.deleted_at IS NOT NULL AND l.status IN ('synced', 'offloaded')))`;
    const photos = queryAll<PhotoRow>(db, `${select('date')} WHERE ${recoverable} ORDER BY p.imported_at, p.id`).map(
      (row): BackupManifestPhotoV13 => {
        const {
          previewFailure: _previewFailure,
          dimensionStatus: _dimensionStatus,
          syncState: _syncState,
          tags: _tags,
          title,
          description,
          userTags,
          importedKeywords,
          suppressedKeywords,
          metadataVersion,
          ...photo
        } = toRecord(row);
        // Variant fields (#496) are omitted when default so a root variant's
        // record keeps its pre-13 byte shape and legacy equality checks hold.
        const { isOriginal, derivativeKey, variantSourceId, assetOwnerId, ...base } = photo;
        const hasMetadata =
          title !== null ||
          description !== null ||
          userTags.length > 0 ||
          importedKeywords.length > 0 ||
          suppressedKeywords.length > 0 ||
          metadataVersion !== 1;
        return {
          ...base,
          ...(isOriginal ? { isOriginal: true } : {}),
          ...(derivativeKey === photo.contentHash ? {} : { derivativeKey }),
          ...(variantSourceId === null ? {} : { variantSourceId }),
          ...(assetOwnerId === null ? {} : { assetOwnerId }),
          ...(hasMetadata ? { title, description, userTags, importedKeywords, suppressedKeywords, metadataVersion } : {}),
          blobPath: `blobs/${photo.contentHash.slice(0, 2)}/${photo.contentHash}`,
        };
      },
    );
    const photoIds = new Set(photos.map((photo) => photo.id));
    const albumRows = queryAll<{ id: string; name: string; createdAt: string; position: number }>(
      db,
      `SELECT id, name, created_at AS createdAt, position FROM albums WHERE kind = 'album' ORDER BY position, id`,
    );
    const members = queryAll<{ albumId: string; photoId: string }>(
      db,
      `SELECT ap.album_id AS albumId, ap.photo_id AS photoId
         FROM album_photos ap
         JOIN albums a ON a.id = ap.album_id
         JOIN ordinary_visible_photos p ON p.id = ap.photo_id
         JOIN sync_ledger l ON l.photo_id = p.id
        WHERE ${recoverable}
        ORDER BY a.position, a.id, ap.position, ap.photo_id`,
    );
    const membersByAlbum = new Map<string, string[]>();
    for (const member of members) {
      if (!photoIds.has(member.photoId)) continue;
      const existing = membersByAlbum.get(member.albumId) ?? [];
      existing.push(member.photoId);
      membersByAlbum.set(member.albumId, existing);
    }
    const albums = albumRows.map((album) => ({ ...album, photoIds: membersByAlbum.get(album.id) ?? [] }));
    const databaseSchema = queryGet<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations')?.version ?? 1;
    const keyIds = [...new Set(photos.map((photo) => photo.keyId))].sort((a, b) => a - b);
    return {
      databaseSchema,
      keyIds,
      photos,
      albums,
      totals: {
        photos: photos.length,
        bytes: photos.reduce((sum, photo) => sum + photo.bytes, 0),
        albums: albums.length,
      },
    };
  })();
}

export function restoreManifest(
  db: BetterSqlite3.Database,
  manifest: RestorableBackupManifest,
  keys: readonly WrappedKeyRecord[],
  missingPhotoIds: ReadonlySet<string> = new Set(),
): void {
  db.transaction(() => {
    const occupied = queryGet<{ count: number }>(
      db,
      `SELECT (SELECT count(*) FROM photos) + (SELECT count(*) FROM albums) + (SELECT count(*) FROM keys) + (SELECT count(*) FROM boards) AS count`,
    );
    if ((occupied?.count ?? 0) !== 0) throw new Error('restore requires an empty staged catalog');
    for (const key of keys) {
      runNamed(
        db,
        `INSERT INTO keys (id, wrapped_key, created_at, retired_at)
         VALUES (@id, @wrappedKey, @createdAt, @retiredAt)`,
        {
          id: key.id,
          wrappedKey: key.wrappedKey,
          createdAt: key.createdAt,
          retiredAt: key.status === 'retired' ? manifest.generatedAt : null,
        },
      );
    }
    for (const photo of manifest.photos) {
      runNamed(
        db,
        `INSERT INTO photos (
           id, file_name, file_kind, width, height, bytes, content_hash,
           camera, lens, iso, aperture, shutter, focal_length, taken_at,
           gps_lat, gps_lon, place, imported_at, import_source, favorite,
           is_original, key_id, deleted_at, media_info, user_title, user_description,
           imported_keywords, user_tags, suppressed_keywords, metadata_tags_search, metadata_version,
           derivative_key, variant_source_id, asset_owner_id
         ) VALUES (
           @id, @fileName, @fileKind, @width, @height, @bytes, @contentHash,
           @camera, @lens, @iso, @aperture, @shutter, @focalLength, @takenAt,
           @gpsLat, @gpsLon, @place, @importedAt, @importSource, @favorite,
           @isOriginal, @keyId, @deletedAt, @mediaInfoJson, @title, @description,
           @importedKeywordsJson, @userTagsJson, @suppressedKeywordsJson, @metadataTagsSearch, @metadataVersion,
           @derivativeKey, @variantSourceId, @assetOwnerId
         )`,
        {
          ...photo,
          derivativeKey: ('derivativeKey' in photo ? photo.derivativeKey : undefined) ?? photo.contentHash,
          variantSourceId: ('variantSourceId' in photo ? photo.variantSourceId : undefined) ?? null,
          assetOwnerId: ('assetOwnerId' in photo ? photo.assetOwnerId : undefined) ?? null,
          favorite: photo.favorite ? 1 : 0,
          isOriginal: photo.isOriginal === true ? 1 : 0,
          mediaInfo: null,
          mediaInfoJson: mediaInfoJson(photo.mediaInfo),
          title: photo.title ?? null,
          description: photo.description ?? null,
          importedKeywordsJson: JSON.stringify(photo.importedKeywords ?? []),
          userTagsJson: JSON.stringify(photo.userTags ?? []),
          suppressedKeywordsJson: JSON.stringify(photo.suppressedKeywords ?? []),
          metadataTagsSearch: [...(photo.importedKeywords ?? []), ...(photo.userTags ?? [])]
            .filter((tag) => !(photo.suppressedKeywords ?? []).some((suppressed) => suppressed.toLowerCase() === tag.toLowerCase()))
            .join(' '),
          metadataVersion: photo.metadataVersion ?? 1,
        },
      );
      // A NOT FOUND original from a partial restore (#915) keeps its row but
      // enters the ledger as 'error' — the scrubber's confirmed-remote-loss
      // vocabulary — with no backup claim to lie about.
      run(
        db,
        `INSERT INTO sync_ledger (photo_id, status, last_backup_at, dirty) VALUES (?, ?, ?, 0)`,
        photo.id,
        missingPhotoIds.has(photo.id) ? 'error' : 'synced',
        missingPhotoIds.has(photo.id) ? null : manifest.generatedAt,
      );
    }
    for (const album of manifest.albums) {
      runNamed(db, `INSERT INTO albums (id, name, created_at, position) VALUES (@id, @name, @createdAt, @position)`, album);
      for (const [position, photoId] of album.photoIds.entries()) {
        run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES (?, ?, ?)`, album.id, photoId, position);
      }
    }
  })();
}
