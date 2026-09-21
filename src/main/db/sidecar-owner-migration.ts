import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

/** References belong to variants; encrypted bytes retain their import owner.
 * A purged root must not change either the path or the authenticated identity.
 * Existing families gain references only where the retained source proves them.
 */
export function migrateSidecarOwners(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE photo_sidecars ADD COLUMN owner_id TEXT;
    UPDATE photo_sidecars SET owner_id = photo_id;
    CREATE INDEX idx_photo_sidecars_owner ON photo_sidecars(coalesce(owner_id, photo_id), content_hash);
    INSERT OR IGNORE INTO photo_sidecars
      (photo_id, role, file_name, content_hash, bytes, key_id, imported_at, owner_id)
    SELECT sibling.id, s.role, s.file_name, s.content_hash, s.bytes, s.key_id, s.imported_at, s.owner_id
    FROM photo_sidecars s
    JOIN ordinary_visible_photos source ON source.id = s.photo_id
    JOIN ordinary_visible_photos sibling ON sibling.content_hash = source.content_hash
      AND coalesce(sibling.asset_owner_id, sibling.id) = coalesce(source.asset_owner_id, source.id)
    WHERE sibling.id != source.id;
    UPDATE sync_ledger SET dirty = 1 WHERE photo_id IN (
      SELECT photo_id FROM photo_sidecars WHERE photo_id != owner_id
    );
  `);
}
