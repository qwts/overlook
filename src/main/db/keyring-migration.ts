import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Migration 36 — the keyring registry (#517, ADR-0032 §2). `keys` stops being
// foreign-key metadata and becomes the non-secret registry of every key the
// library has seen: what kind it is, the stable 128-bit reference envelopes
// and manifests name it by, its version, an HKDF fingerprint, a label, where
// it came from, and whether this device currently holds its material. The
// wrapped secret stays where ADR-0004 put it — keys.json under the master
// key — so nothing here ever decrypts a photo.
//
// Existing rows are library keys minted here; they receive a fresh reference
// at migration time, and the trigger keeps the column total for any writer
// that still inserts the legacy three columns.
export function migrateLibraryKeyring(db: BetterSqlite3.Database): void {
  db.exec(`
    ALTER TABLE keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'library' CHECK (kind IN ('library', 'item', 'space'));
    ALTER TABLE keys ADD COLUMN key_ref TEXT CHECK (key_ref IS NULL OR (length(key_ref) = 32 AND key_ref NOT GLOB '*[^0-9a-f]*'));
    ALTER TABLE keys ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
    ALTER TABLE keys ADD COLUMN fingerprint TEXT;
    ALTER TABLE keys ADD COLUMN label TEXT;
    ALTER TABLE keys ADD COLUMN origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'imported', 'received'));
    ALTER TABLE keys ADD COLUMN wrap_scheme TEXT NOT NULL DEFAULT 'master-aes-256-gcm';
    ALTER TABLE keys ADD COLUMN material_present INTEGER NOT NULL DEFAULT 1 CHECK (material_present IN (0, 1));
    UPDATE keys SET key_ref = lower(hex(randomblob(16))) WHERE key_ref IS NULL;
    CREATE UNIQUE INDEX idx_keys_ref ON keys (key_ref, version);
    CREATE TRIGGER keys_mint_ref AFTER INSERT ON keys WHEN NEW.key_ref IS NULL
    BEGIN
      UPDATE keys SET key_ref = lower(hex(randomblob(16))) WHERE id = NEW.id;
    END;
  `);
}
