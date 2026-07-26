import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, run } from './sql.js';

// Forward-only, versioned, transactional migrations per ADR-0005 (#69).
// Broken migrations roll forward with a fix — there are no down migrations.

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: BetterSqlite3.Database) => void;
}

// Migration 001 — ADR-0005 schema v1 (+ the recorded photos.deleted_at
// amendment for the design's Recently-deleted source).
const SCHEMA_V1: Migration = {
  version: 1,
  name: 'schema-v1',
  up: (db) => {
    db.exec(`
      -- ADR-0005 shape: wrapped key material lives here (wrapped by the
      -- master key, #68); active = retired_at IS NULL.
      CREATE TABLE keys (
        id INTEGER PRIMARY KEY,
        wrapped_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT
      );

      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_kind TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        camera TEXT,
        lens TEXT,
        iso INTEGER,
        aperture TEXT,
        shutter TEXT,
        focal_length REAL,
        taken_at TEXT,
        gps_lat REAL,
        gps_lon REAL,
        place TEXT,
        imported_at TEXT NOT NULL,
        import_source TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        key_id INTEGER NOT NULL REFERENCES keys (id),
        deleted_at TEXT
      );

      -- Keyset-pagination index: sort key is COALESCE(taken_at, imported_at)
      -- so NULL capture dates never break the cursor (ADR-0005 §pagination).
      CREATE INDEX idx_photos_sort ON photos (COALESCE(taken_at, imported_at) DESC, id DESC);
      CREATE INDEX idx_photos_favorite ON photos (favorite) WHERE favorite = 1;
      CREATE INDEX idx_photos_deleted ON photos (deleted_at) WHERE deleted_at IS NOT NULL;

      CREATE TABLE albums (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        position INTEGER NOT NULL
      );

      CREATE TABLE album_photos (
        album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
        photo_id TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (album_id, photo_id)
      );

      CREATE TABLE sync_ledger (
        photo_id TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('local', 'syncing', 'synced', 'offloaded')),
        last_backup_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX idx_ledger_status ON sync_ledger (status);

      -- ADR-0005 search: external-content FTS5 over name/place/camera,
      -- trigger-synced from day one (no backfill migration later).
      CREATE VIRTUAL TABLE photos_fts USING fts5(
        file_name, place, camera,
        content='photos', content_rowid='rowid'
      );
      CREATE TRIGGER photos_fts_ai AFTER INSERT ON photos BEGIN
        INSERT INTO photos_fts (rowid, file_name, place, camera)
        VALUES (new.rowid, new.file_name, new.place, new.camera);
      END;
      CREATE TRIGGER photos_fts_ad AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts (photos_fts, rowid, file_name, place, camera)
        VALUES ('delete', old.rowid, old.file_name, old.place, old.camera);
      END;
      CREATE TRIGGER photos_fts_au AFTER UPDATE ON photos BEGIN
        INSERT INTO photos_fts (photos_fts, rowid, file_name, place, camera)
        VALUES ('delete', old.rowid, old.file_name, old.place, old.camera);
        INSERT INTO photos_fts (rowid, file_name, place, camera)
        VALUES (new.rowid, new.file_name, new.place, new.camera);
      END;
    `);
  },
};

const SCHEMA_V2: Migration = {
  version: 2,
  name: 'sync-ledger-error-status',
  // #104 (ADR-0007): the ledger vocabulary gains 'error' (sync failed, will
  // retry). SQLite cannot alter a CHECK, so the table rebuilds in place —
  // forward-only per the migration policy.
  up(db) {
    db.exec(`
      CREATE TABLE sync_ledger_v2 (
        photo_id TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('local', 'syncing', 'synced', 'offloaded', 'error')),
        last_backup_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sync_ledger_v2 (photo_id, status, last_backup_at, dirty)
        SELECT photo_id, status, last_backup_at, dirty FROM sync_ledger;
      DROP TABLE sync_ledger;
      ALTER TABLE sync_ledger_v2 RENAME TO sync_ledger;
      CREATE INDEX idx_ledger_status ON sync_ledger (status);
    `);
  },
};

const SCHEMA_V3: Migration = {
  version: 3,
  name: 'sort-order-indexes',
  // #113 (PR #212 review): Name and Size orderings need their own keyset
  // indexes or a 200K-library sort forces a full scan + temp B-tree before
  // every limited page. Each matches its ORDER BY expression exactly.
  up(db) {
    db.exec(`
      CREATE INDEX idx_photos_name ON photos (lower(file_name), id);
      CREATE INDEX idx_photos_size ON photos (bytes DESC, id DESC);
    `);
  },
};

const SCHEMA_V4: Migration = {
  version: 4,
  name: 'backup-integrity-cursors',
  // #302: each provider resumes its own bounded integrity walk. A library
  // can switch providers, so one global cursor would skip unaudited objects
  // on the newly selected remote.
  up(db) {
    db.exec(`
      CREATE TABLE backup_integrity_cursors (
        provider_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version = 1),
        after_photo_id TEXT,
        completed_at TEXT
      );
    `);
  },
};

const SCHEMA_V5: Migration = {
  version: 5,
  name: 'interop-record-custody',
  // #332: canonical Image Trail records remain first-class interop data.
  // Metadata-only web bookmarks are not fabricated as native camera-photo
  // rows; a local link is populated only when translation creates one.
  up(db) {
    db.exec(`
      CREATE TABLE interop_records (
        interop_id TEXT PRIMARY KEY,
        origin_product TEXT NOT NULL CHECK (origin_product IN ('image-trail', 'overlook')),
        origin_local_id TEXT NOT NULL,
        content_hash TEXT,
        local_photo_id TEXT REFERENCES photos (id) ON DELETE SET NULL,
        review_category TEXT NOT NULL CHECK (
          review_category IN ('eligible', 'duplicate', 'conflict', 'metadata-only', 'unsupported', 'skipped')
        ),
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        received_at TEXT NOT NULL,
        UNIQUE (origin_product, origin_local_id)
      );
      CREATE INDEX idx_interop_records_content_hash ON interop_records (content_hash) WHERE content_hash IS NOT NULL;
      CREATE INDEX idx_interop_records_local_photo ON interop_records (local_photo_id) WHERE local_photo_id IS NOT NULL;

      CREATE TABLE interop_albums (
        interop_id TEXT PRIMARY KEY,
        origin_product TEXT NOT NULL CHECK (origin_product IN ('image-trail', 'overlook')),
        origin_local_id TEXT NOT NULL,
        local_album_id TEXT REFERENCES albums (id) ON DELETE SET NULL,
        album_json TEXT NOT NULL CHECK (json_valid(album_json)),
        received_at TEXT NOT NULL,
        UNIQUE (origin_product, origin_local_id)
      );
      CREATE INDEX idx_interop_albums_local_album ON interop_albums (local_album_id) WHERE local_album_id IS NOT NULL;
    `);
  },
};

const SCHEMA_V6: Migration = {
  version: 6,
  name: 'protected-album-custody',
  // #325: this table is deliberately independent of ordinary albums. During
  // #326's re-encryption journal, an ordinary row and a staged protected row
  // can coexist while every public query continues to expose only the former.
  up(db) {
    db.exec(`
      CREATE TABLE protected_album_records (
        album_id TEXT PRIMARY KEY,
        record_version INTEGER NOT NULL CHECK (record_version = 1),
        migration_state TEXT NOT NULL CHECK (migration_state IN ('staged', 'active', 'retiring')),
        credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
        metadata_generation INTEGER NOT NULL CHECK (metadata_generation > 0),
        credential_record BLOB NOT NULL,
        sealed_metadata BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX idx_protected_album_migration_state ON protected_album_records (migration_state);
    `);
  },
};

const SCHEMA_V7: Migration = {
  version: 7,
  name: 'interop-move-journals',
  // #333: Move is a two-party protocol, not a delete operation. Requests,
  // target receipts, acknowledgements, source finalization, and audit events
  // are durable independently so every crash boundary can be resumed.
  up(db) {
    db.exec(`
      CREATE TABLE interop_move_journals (
        transfer_id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL,
        source_product TEXT NOT NULL CHECK (source_product IN ('image-trail', 'overlook')),
        target_product TEXT NOT NULL CHECK (target_product IN ('image-trail', 'overlook')),
        phase TEXT NOT NULL CHECK (phase IN (
          'queued', 'reviewing', 'transferring', 'paused', 'awaiting-acknowledgement',
          'acknowledged', 'finalizing', 'completed', 'cancelled', 'failed'
        )),
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (source_product <> target_product)
      ) WITHOUT ROWID;

      CREATE TABLE interop_move_items (
        transfer_id TEXT NOT NULL REFERENCES interop_move_journals (transfer_id) ON DELETE CASCADE,
        interop_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_local_id TEXT NOT NULL,
        review_category TEXT NOT NULL CHECK (
          review_category IN ('eligible', 'duplicate', 'conflict', 'metadata-only', 'unsupported', 'skipped')
        ),
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'received', 'acknowledged', 'finalizing', 'finalized', 'rejected', 'failed'
        )),
        target_local_id TEXT,
        metadata_persisted INTEGER NOT NULL DEFAULT 0 CHECK (metadata_persisted IN (0, 1)),
        original_verification TEXT NOT NULL DEFAULT 'pending' CHECK (
          original_verification IN ('pending', 'verified', 'metadata-only', 'unavailable')
        ),
        acknowledgement_message_id TEXT,
        acknowledged_message_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acknowledged_message_ids_json)),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        received_at TEXT,
        acknowledged_at TEXT,
        finalized_at TEXT,
        PRIMARY KEY (transfer_id, interop_id),
        UNIQUE (transfer_id, source_message_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_interop_move_items_state ON interop_move_items (transfer_id, state);

      CREATE TABLE interop_move_outbox (
        message_id TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL REFERENCES interop_move_journals (transfer_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('record', 'acknowledgement', 'journal', 'error')),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        created_at TEXT NOT NULL,
        delivered_at TEXT
      ) WITHOUT ROWID;
      CREATE INDEX idx_interop_move_outbox_pending ON interop_move_outbox (transfer_id, sequence)
        WHERE delivered_at IS NULL;

      CREATE TABLE interop_move_receipts (
        pairing_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        transfer_id TEXT NOT NULL REFERENCES interop_move_journals (transfer_id) ON DELETE CASCADE,
        response_message_id TEXT,
        received_at TEXT NOT NULL,
        PRIMARY KEY (pairing_id, message_id)
      ) WITHOUT ROWID;

      CREATE TABLE interop_move_audit (
        event_key TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL REFERENCES interop_move_journals (transfer_id) ON DELETE CASCADE,
        interop_id TEXT,
        event TEXT NOT NULL CHECK (event IN (
          'queued', 'received', 'acknowledged', 'rejected', 'finalizing', 'finalized', 'failed'
        )),
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX idx_interop_move_audit_transfer ON interop_move_audit (transfer_id, created_at, event_key);
    `);
  },
};

const SCHEMA_V8: Migration = {
  version: 8,
  name: 'protected-photo-migration-journal',
  // #326: protected photo custody is separate from ordinary photos and its
  // crash journal survives every copy/verify/commit/purge boundary. Blob
  // references in protected_photo_records are opaque, domain-scoped ids;
  // plaintext content hashes remain only in an in-flight source journal and
  // disappear when custody transfer finishes.
  up(db) {
    db.exec(`
      CREATE TABLE protected_photo_migrations (
        migration_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN ('protect', 'unprotect', 'move')),
        source_album_id TEXT REFERENCES protected_album_records (album_id),
        target_album_id TEXT REFERENCES protected_album_records (album_id),
        phase TEXT NOT NULL CHECK (phase IN ('prepare', 'copy', 'verify', 'commit', 'purge')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (operation = 'protect' AND source_album_id IS NULL AND target_album_id IS NOT NULL) OR
          (operation = 'unprotect' AND source_album_id IS NOT NULL AND target_album_id IS NULL) OR
          (operation = 'move' AND source_album_id IS NOT NULL AND target_album_id IS NOT NULL AND source_album_id <> target_album_id)
        )
      ) WITHOUT ROWID;

      CREATE TABLE protected_photo_migration_items (
        migration_id TEXT NOT NULL REFERENCES protected_photo_migrations (migration_id) ON DELETE CASCADE,
        photo_id TEXT NOT NULL,
        source_blob_ref TEXT NOT NULL,
        target_blob_ref TEXT NOT NULL,
        sealed_target_metadata BLOB NOT NULL,
        has_thumb INTEGER NOT NULL CHECK (has_thumb IN (0, 1)),
        has_mid INTEGER NOT NULL CHECK (has_mid IN (0, 1)),
        item_phase TEXT NOT NULL CHECK (item_phase IN ('prepare', 'copy', 'verify', 'commit', 'purge')),
        PRIMARY KEY (migration_id, photo_id),
        UNIQUE (photo_id)
      ) WITHOUT ROWID;

      CREATE TABLE protected_photo_records (
        photo_id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL REFERENCES protected_album_records (album_id) ON DELETE RESTRICT,
        record_version INTEGER NOT NULL CHECK (record_version = 1),
        blob_ref TEXT NOT NULL CHECK (length(blob_ref) = 64 AND blob_ref NOT GLOB '*[^0-9a-f]*'),
        sealed_metadata BLOB NOT NULL,
        has_thumb INTEGER NOT NULL CHECK (has_thumb IN (0, 1)),
        has_mid INTEGER NOT NULL CHECK (has_mid IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX idx_protected_photo_album ON protected_photo_records (album_id);
      CREATE INDEX idx_protected_photo_blob ON protected_photo_records (album_id, blob_ref);

      -- Public ordinary-library reads use this view. A photo disappears as
      -- soon as prepare commits and cannot flicker back between copy phases.
      CREATE VIEW ordinary_visible_photos AS
        SELECT p.* FROM photos p
        WHERE NOT EXISTS (
          SELECT 1 FROM protected_photo_migration_items item WHERE item.photo_id = p.id
        );
    `);
  },
};

const SCHEMA_V9: Migration = {
  version: 9,
  name: 'interop-sync-journals',
  // #334: Sync decisions, receipts, tombstone reviews, and controls must
  // survive restart independently of provider transport and renderer state.
  up(db) {
    db.exec(`
      CREATE TABLE interop_sync_sessions (
        session_id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL,
        source_product TEXT NOT NULL CHECK (source_product IN ('image-trail', 'overlook')),
        target_product TEXT NOT NULL CHECK (target_product IN ('image-trail', 'overlook')),
        direction TEXT NOT NULL CHECK (direction IN ('image-trail-to-overlook', 'overlook-to-image-trail', 'two-way')),
        scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
        phase TEXT NOT NULL CHECK (phase IN ('reviewing', 'transferring', 'paused', 'completed', 'cancelled', 'failed')),
        connected INTEGER NOT NULL DEFAULT 1 CHECK (connected IN (0, 1)),
        image_trail_checkpoint INTEGER NOT NULL DEFAULT 0 CHECK (image_trail_checkpoint >= 0),
        overlook_checkpoint INTEGER NOT NULL DEFAULT 0 CHECK (overlook_checkpoint >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (source_product <> target_product)
      ) WITHOUT ROWID;

      CREATE TABLE interop_sync_items (
        session_id TEXT NOT NULL REFERENCES interop_sync_sessions (session_id) ON DELETE CASCADE,
        interop_id TEXT NOT NULL,
        image_trail_record_json TEXT CHECK (image_trail_record_json IS NULL OR json_valid(image_trail_record_json)),
        overlook_record_json TEXT CHECK (overlook_record_json IS NULL OR json_valid(overlook_record_json)),
        analysis_json TEXT NOT NULL CHECK (json_valid(analysis_json)),
        decisions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(decisions_json)),
        delete_decision TEXT CHECK (delete_decision IN ('apply', 'keep')),
        state TEXT NOT NULL CHECK (state IN (
          'eligible', 'duplicate', 'conflict', 'delete-review', 'ready', 'applied', 'skipped', 'failed'
        )),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        received_at TEXT NOT NULL,
        applied_at TEXT,
        PRIMARY KEY (session_id, interop_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_interop_sync_items_state ON interop_sync_items (session_id, state, interop_id);

      CREATE TABLE interop_sync_receipts (
        pairing_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES interop_sync_sessions (session_id) ON DELETE CASCADE,
        interop_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        received_at TEXT NOT NULL,
        PRIMARY KEY (pairing_id, message_id)
      ) WITHOUT ROWID;

      CREATE TABLE interop_sync_audit (
        event_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES interop_sync_sessions (session_id) ON DELETE CASCADE,
        interop_id TEXT,
        event TEXT NOT NULL CHECK (event IN (
          'started', 'received', 'decision', 'delete-reviewed', 'paused', 'resumed',
          'cancelled', 'disconnected', 'applied', 'skipped', 'failed', 'checkpoint'
        )),
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX idx_interop_sync_audit_session ON interop_sync_audit (session_id, created_at, event_key);
    `);
  },
};

const SCHEMA_V10: Migration = {
  version: 10,
  name: 'protected-cloud-ledger',
  // #328: protected ciphertext has an independent remote ledger. Provider
  // object identity is derived only from the opaque blob ref; album names,
  // plaintext hashes, and membership never enter this table or remote paths.
  up(db) {
    db.exec(`
      ALTER TABLE protected_album_records
        ADD COLUMN manifest_dirty INTEGER NOT NULL DEFAULT 1 CHECK (manifest_dirty IN (0, 1));
      ALTER TABLE protected_photo_records
        ADD COLUMN manifest_dirty INTEGER NOT NULL DEFAULT 1 CHECK (manifest_dirty IN (0, 1));

      CREATE TABLE protected_remote_objects (
        photo_id TEXT NOT NULL REFERENCES protected_photo_records (photo_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('original', 'thumb', 'mid')),
        status TEXT NOT NULL DEFAULT 'local' CHECK (status IN ('local', 'synced', 'offloaded', 'error')),
        dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
        ciphertext_sha256 TEXT CHECK (
          ciphertext_sha256 IS NULL OR
          (length(ciphertext_sha256) = 64 AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        ciphertext_bytes INTEGER CHECK (ciphertext_bytes IS NULL OR ciphertext_bytes >= 0),
        last_backup_at TEXT,
        PRIMARY KEY (photo_id, kind),
        CHECK (
          (ciphertext_sha256 IS NULL AND ciphertext_bytes IS NULL) OR
          (ciphertext_sha256 IS NOT NULL AND ciphertext_bytes IS NOT NULL)
        )
      ) WITHOUT ROWID;
      CREATE INDEX idx_protected_remote_status ON protected_remote_objects (status, dirty, photo_id, kind);

      INSERT INTO protected_remote_objects (photo_id, kind)
        SELECT photo_id, 'original' FROM protected_photo_records;
      INSERT INTO protected_remote_objects (photo_id, kind)
        SELECT photo_id, 'thumb' FROM protected_photo_records WHERE has_thumb = 1;
      INSERT INTO protected_remote_objects (photo_id, kind)
        SELECT photo_id, 'mid' FROM protected_photo_records WHERE has_mid = 1;
    `);
  },
};

const SCHEMA_V11: Migration = {
  version: 11,
  name: 'preview-failure-status',
  // #487: derivative/display failures are local repair state, not original
  // metadata and not part of the recoverable backup manifest.
  up(db) {
    db.exec(`
      ALTER TABLE photos ADD COLUMN preview_failure TEXT CHECK (
        preview_failure IS NULL OR preview_failure IN ('corrupt', 'unsupported-codec', 'decode-failed')
      );
    `);
  },
};

const SCHEMA_V12: Migration = {
  version: 12,
  name: 'dimension-verification-status',
  // #500: decoder-vs-metadata comparison is local integrity/repair state.
  // Existing rows are rechecked lazily; backup manifests remain unchanged.
  up(db) {
    db.exec(`
      ALTER TABLE photos ADD COLUMN dimension_status TEXT NOT NULL DEFAULT 'legacy' CHECK (
        dimension_status IN ('legacy', 'verified', 'metadata-mismatch', 'unavailable')
      );
    `);
  },
};

const SCHEMA_V13: Migration = {
  version: 13,
  name: 'encrypted-activity-history',
  // #614 / ADR-0025: user-facing activity is an append-only projection in
  // each library's SQLCipher database. Retention holds are the narrow seam
  // #615 can use without putting inverse parameters in general history.
  up(db) {
    db.exec(`
      CREATE TABLE activity_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        occurred_at TEXT NOT NULL,
        actor_class TEXT NOT NULL CHECK (actor_class IN ('local-user', 'system', 'interop-peer', 'recovery')),
        root_correlation_id TEXT NOT NULL,
        causation_event_id TEXT,
        entity_ids_json TEXT NOT NULL CHECK (json_valid(entity_ids_json)),
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'partial', 'failed')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        supersedes_event_id TEXT,
        UNIQUE (operation_id, event_type)
      );
      CREATE INDEX idx_activity_occurred ON activity_events (occurred_at, sequence);
      CREATE INDEX idx_activity_root ON activity_events (root_correlation_id, sequence);

      CREATE TABLE activity_pending_publications (
        event_id TEXT PRIMARY KEY,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX idx_activity_pending_created ON activity_pending_publications (created_at, event_id);

      CREATE TABLE activity_retention_holds (
        event_id TEXT NOT NULL REFERENCES activity_events (event_id) ON DELETE CASCADE,
        hold_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (event_id, hold_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_activity_holds_expiry ON activity_retention_holds (expires_at, event_id);
    `);
  },
};

const SCHEMA_V14: Migration = {
  version: 14,
  name: 'media-info',
  // #547 per ADR-0026 §1: probed container facts (animation for GIF/WebP;
  // video/audio streams later) as validated JSON. Facts only — per-device
  // playability is derived at runtime and never persisted (ADR-0026 §3).
  up(db) {
    db.exec(`
      ALTER TABLE photos ADD COLUMN media_info TEXT CHECK (
        media_info IS NULL OR json_valid(media_info)
      );
    `);
  },
};

const SCHEMA_V15: Migration = {
  version: 15,
  name: 'capability-aware-undo',
  // #615 / ADR-0025: encrypted command records are separate from activity.
  // A library database is the isolation boundary; inverse parameters never
  // enter the renderer-facing activity payload.
  up(db) {
    db.exec(`
      CREATE TABLE command_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL UNIQUE,
        activity_event_id TEXT NOT NULL REFERENCES activity_events (event_id) ON DELETE CASCADE,
        command_id TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN (
          'immediately-reversible', 'conditionally-reversible', 'compensating-only', 'irreversible'
        )),
        inverse_json TEXT NOT NULL CHECK (json_valid(inverse_json)),
        stack TEXT NOT NULL CHECK (stack IN ('undo', 'redo', 'discarded')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        sensitive_expires_at TEXT,
        byte_charge INTEGER NOT NULL DEFAULT 0 CHECK (byte_charge >= 0)
      );
      CREATE INDEX idx_command_stack ON command_records (stack, sequence DESC);
      CREATE INDEX idx_command_expiry ON command_records (expires_at, sequence);

      CREATE TABLE command_executions (
        request_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES command_records (record_id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('undo', 'redo')),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  },
};

const SCHEMA_V16: Migration = {
  version: 16,
  name: 'protected-original-marker',
  // #482: durable user-declared preservation state. This stays on the photo
  // row so every destructive SQL boundary can fail closed without consulting
  // renderer state or a derived duplicate index.
  up(db) {
    db.exec(`
      ALTER TABLE photos ADD COLUMN is_original INTEGER NOT NULL DEFAULT 0
        CHECK (is_original IN (0, 1));
      CREATE INDEX idx_photos_original ON photos (is_original) WHERE is_original = 1;
    `);
  },
};

const SCHEMA_V17: Migration = {
  version: 17,
  name: 'interop-inbound-object-journal',
  // #668: discovery is durable before any inbound side effect. Record and
  // original-blob messages advance independently through acceptance and ACK
  // upload so restart never duplicates a blob, row, or acknowledgement.
  up(db) {
    db.exec(`
      CREATE TABLE interop_move_inbound_objects (
        transfer_id TEXT NOT NULL REFERENCES interop_move_journals (transfer_id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL,
        object_path TEXT NOT NULL,
        object_kind TEXT NOT NULL CHECK (object_kind IN ('record-message', 'blob-message')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        interop_id TEXT,
        deterministic_target_id TEXT,
        phase TEXT NOT NULL CHECK (phase IN (
          'discovered', 'validated', 'blob-committed', 'database-committed',
          'ack-journaled', 'ack-uploaded', 'retained', 'failed'
        )),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        retry_at TEXT,
        acknowledgement_message_id TEXT,
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (transfer_id, object_path),
        UNIQUE (transfer_id, source_message_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_interop_move_inbound_resume
        ON interop_move_inbound_objects (phase, retry_at, transfer_id, sequence);
    `);
  },
};

const SCHEMA_V18: Migration = {
  version: 18,
  name: 'moodboards',
  // #515: a moodboard is album-class organizational metadata — a named board
  // holding an ordered list of placements (references to photos + display
  // transforms) stored as canonical JSON. There is deliberately NO foreign key
  // to photos: deleting a photo must leave an "unavailable" placement, not
  // cascade-remove it (the layout is byte-stable across the photo's absence).
  up(db) {
    db.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        board_width INTEGER NOT NULL CHECK (board_width > 0),
        board_height INTEGER NOT NULL CHECK (board_height > 0),
        background TEXT NOT NULL,
        placements TEXT NOT NULL CHECK (json_valid(placements)),
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
};

const SCHEMA_V19: Migration = {
  version: 19,
  name: 'durable-manifest-debt',
  // #741: a manifest generation owed to the remote survives restart instead
  // of living in engine memory — a run interrupted between "library changed"
  // and "generation published" must not forget the remote holds a stale
  // manifest. Provider custody provenance is deliberately NOT added here:
  // that schema belongs to ADR-0028 §1/§7 (#729, custody_authorities).
  up(db) {
    db.exec(`
      CREATE TABLE backup_manifest_debt (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owed INTEGER NOT NULL CHECK (owed IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `);
  },
};

const SCHEMA_V20: Migration = {
  version: 20,
  name: 'custody-authorities',
  // #729 / ADR-0028 §1, §7: sole-remote-custody provenance is library
  // scoped. Existing offloaded rows stay deliberately unbound; the later
  // reconciliation verifies their home instead of guessing from credentials.
  up(db) {
    db.exec(`
      CREATE TABLE custody_authorities (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        remote_root TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('bound', 'provider-required')),
        created_at TEXT NOT NULL,
        last_verified_at TEXT,
        UNIQUE (provider_id, account_id, remote_root)
      );
      CREATE INDEX idx_custody_authorities_provider_account
        ON custody_authorities (provider_id, account_id);

      ALTER TABLE sync_ledger ADD COLUMN custody_authority_id INTEGER
        REFERENCES custody_authorities(id);
      CREATE INDEX idx_ledger_custody_authority
        ON sync_ledger (custody_authority_id)
        WHERE custody_authority_id IS NOT NULL;
    `);
  },
};

const SCHEMA_V21: Migration = {
  version: 21,
  name: 'encrypted-photo-embeddings',
  // #391 / ADR-0018 §4: portable metadata lives in SQLCipher on every target.
  // database.ts creates the vec0 table after migration when the exact-pinned
  // native extension is available. This keeps Windows ARM64 libraries usable
  // while upstream lacks that one prebuilt binary.
  up(db) {
    db.exec(`
      CREATE TABLE photo_embeddings (
        embedding_id INTEGER PRIMARY KEY,
        photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        model_version TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        UNIQUE (photo_id, model_version)
      );
      CREATE INDEX idx_photo_embeddings_model
        ON photo_embeddings (model_version, photo_id);
    `);
  },
};

const SCHEMA_V22: Migration = {
  version: 22,
  name: 'embedding-derivative-deferrals',
  // A missing/corrupt derivative is a per-photo condition, not a reason to
  // poison the whole query-backed sweep. Keep the retry marker inside the
  // encrypted library and clear it when an eligibility-changing repair lands.
  up(db) {
    db.exec(`
      CREATE TABLE photo_embedding_deferrals (
        photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        model_version TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('derivative-unavailable')),
        deferred_at TEXT NOT NULL,
        PRIMARY KEY (photo_id, model_version)
      ) WITHOUT ROWID;
      CREATE INDEX idx_photo_embedding_deferrals_model
        ON photo_embedding_deferrals (model_version, photo_id);
    `);
  },
};

export const MIGRATIONS: readonly Migration[] = [
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
  SCHEMA_V11,
  SCHEMA_V12,
  SCHEMA_V13,
  SCHEMA_V14,
  SCHEMA_V15,
  SCHEMA_V16,
  SCHEMA_V17,
  SCHEMA_V18,
  SCHEMA_V19,
  SCHEMA_V20,
  SCHEMA_V21,
  SCHEMA_V22,
];

/** Applies pending migrations in order; each in its own transaction. */
export function migrate(db: BetterSqlite3.Database, migrations: readonly Migration[] = MIGRATIONS): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(queryAll<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((row) => row.version));
  let ran = 0;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      run(db, 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', migration.version, new Date().toISOString());
    })();
    ran += 1;
  }
  return ran;
}
