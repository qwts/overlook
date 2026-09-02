import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { readHiddenAlbumIds, verifyInAllPhotos } from '../db/album-visibility-repository.js';
import { runNamed } from '../db/sql.js';
import type { RestorableBackupManifest } from './backup-manifest.js';
import { albumFoldersMatch, restoreAlbumFolders, settleInheritedVisibility } from './restore-album-folders.js';

// Collection visibility is library data (ADR-0030 §5): a restored library
// hides exactly the albums the backed-up one hid. The per-photo flag is never
// restored — it is rebuilt from the restored rows (§7), so a manifest carries
// only the album policy. Folders (#505) are written first so inherited
// policies have a folder to follow.

export function restoreAlbumVisibility(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): void {
  restoreAlbumFolders(db, manifest);
  if ('hiddenAlbumIds' in manifest) {
    for (const albumId of manifest.hiddenAlbumIds) {
      runNamed(db, 'UPDATE albums SET show_in_all_photos = 0 WHERE id = @albumId', { albumId });
    }
  }
  settleInheritedVisibility(db);
  verifyInAllPhotos(db);
}

export function albumVisibilityMatches(db: BetterSqlite3.Database, manifest: RestorableBackupManifest): boolean {
  const expected = 'hiddenAlbumIds' in manifest ? [...manifest.hiddenAlbumIds].sort() : [];
  const actual = [...readHiddenAlbumIds(db)].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) return false;
  if (!albumFoldersMatch(db, manifest)) return false;
  return verifyInAllPhotos(db).mismatched === 0;
}
