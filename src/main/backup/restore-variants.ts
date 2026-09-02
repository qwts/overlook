import { addAbortSignal } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';
import type { KeyStore } from '../crypto/keystore.js';
import { VariantRepository } from '../db/variant-repository.js';
import type { ThumbnailService } from '../import/thumbnail-service.js';
import type { EditTransform } from '../../shared/library/edit-revision.js';
import type { BackupManifestPhotoV13, RestorableBackupManifest } from './backup-manifest.js';
import { assetOwnerOf } from '../../shared/library/asset-owner.js';

// Variant families are library data (ADR-0031 §7): a restored library carries
// the same Promoted representatives the backed-up one had. Manifests older
// than schema 13 name none — every photo restores as the root variant of its
// own asset with its derivatives under its content hash (§8).

export function restoreVariantFamilies(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): void {
  if (!('variantFamilies' in manifest)) return;
  new VariantRepository(db).restoreFamilies(manifest.variantFamilies);
}

export function variantFamiliesMatch(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): boolean {
  const expected = 'variantFamilies' in manifest ? manifest.variantFamilies : [];
  const actual = new VariantRepository(db).familiesSnapshot();
  const key = (rows: readonly { contentHash: string; representativeId: string }[]): string =>
    rows.map((row) => `${row.contentHash}:${row.representativeId}`).join('\n');
  return key(expected) === key(actual);
}

/** The derivative address of a manifest photo: its own key from schema 13 on, its content hash before. */
export function manifestDerivativeKey(photo: { readonly contentHash: string; readonly derivativeKey?: string | undefined }): string {
  return photo.derivativeKey ?? photo.contentHash;
}

/**
 * Rebuilds one restored photo's thumb and mid derivatives from its verified
 * original, baking the head transform the backed-up library showed (#493)
 * under the variant's own derivative key (#496).
 */
export async function bakeRestoredDerivatives(
  thumbnails: Pick<ThumbnailService, 'generateFor'>,
  store: BlobStore,
  recoveredKeys: KeyStore,
  discovery: { readonly resolveKey: KeyResolver },
  photo: Pick<BackupManifestPhotoV13, 'id' | 'contentHash' | 'fileKind' | 'derivativeKey' | 'assetOwnerId'>,
  transform: EditTransform | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const plaintext = await buffer(
    signal === undefined
      ? store.getStream(photo.contentHash, discovery.resolveKey, assetOwnerOf(photo))
      : addAbortSignal(signal, store.getStream(photo.contentHash, discovery.resolveKey, assetOwnerOf(photo))),
  );
  try {
    await thumbnails.generateFor({
      photoId: photo.id,
      bytes: plaintext,
      contentHash: photo.contentHash,
      derivativeKey: manifestDerivativeKey(photo),
      key: recoveredKeys.currentKey(),
      fileKind: photo.fileKind,
      transform,
      signal,
    });
  } finally {
    plaintext.fill(0);
  }
}
