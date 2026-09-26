import { assetOwnerOf } from '../../shared/library/asset-owner.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyStore } from '../crypto/keystore.js';
import { RestoreError } from './restore-types.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import type { KeyResolver } from '../crypto/envelope.js';
import { run } from '../db/sql.js';

/** Catalog key metadata can predate or follow the provider envelope. Preserve
 * the key that actually authenticated restored bytes, and the fresh preview key,
 * without changing the verified manifest projection or rewriting provider data. */
async function verifyRestoredKeyCustody(
  db: BetterSqlite3.Database,
  photoId: string,
  resolveKey: KeyResolver,
  previewKeyId: number,
  verify: (resolve: KeyResolver) => Promise<boolean>,
): Promise<boolean> {
  const used = new Set<number>([previewKeyId]);
  const valid = await verify((id) => {
    used.add(id);
    return resolveKey(id);
  });
  if (!valid) return false;
  db.transaction(() => {
    for (const keyId of used) {
      run(
        db,
        `INSERT OR IGNORE INTO retained_photo_keys (photo_id, key_id)
        SELECT id, ? FROM photos WHERE id = ? AND key_id != ?`,
        keyId,
        photoId,
        keyId,
      );
    }
  })();
  return true;
}

export async function verifyRestoredCustody(
  db: BetterSqlite3.Database,
  store: Pick<BlobStore, 'verifyOriginal'>,
  resolveKey: KeyResolver,
  keys: Pick<KeyStore, 'currentKey'>,
  photos: readonly { readonly id: string; readonly contentHash: string; readonly assetOwnerId?: string | null | undefined }[],
  skip: ReadonlySet<string>,
): Promise<void> {
  for (const photo of photos) {
    if (skip.has(photo.id)) continue;
    const valid = await verifyRestoredKeyCustody(db, photo.id, resolveKey, keys.currentKey().id, (resolve) =>
      store.verifyOriginal(photo.contentHash, resolve, assetOwnerOf(photo)),
    );
    if (!valid) throw new RestoreError('corrupt', `final verification failed for ${photo.id}`);
  }
}
