import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, run, runNamed } from './sql.js';
import type { KeyKind, KeyOrigin } from '../../shared/keyring/types.js';

// The keyring registry (#517, ADR-0032 §2): non-secret facts about every key
// the library references. Presence is a per-device fact reconciled from the
// KeyStore at every open, import and removal; the rows themselves survive a
// key's removal because photos and sidecars keep naming the key id.

export interface KeyringRow {
  readonly id: number;
  readonly keyRef: string;
  readonly version: number;
  readonly kind: KeyKind;
  readonly origin: KeyOrigin;
  readonly label: string | null;
  readonly fingerprint: string | null;
  readonly createdAt: string;
  /** The write key: retired_at IS NULL and material present. */
  readonly active: boolean;
  readonly present: boolean;
}

export interface KeyringUsage {
  readonly photos: number;
  readonly sidecars: number;
  readonly bytes: number;
}

export interface KeyringRegistration {
  readonly id: number;
  readonly keyRef: string;
  readonly version: number;
  readonly kind: KeyKind;
  readonly origin: KeyOrigin;
  readonly fingerprint: string | null;
  readonly createdAt: string;
  /** Null for the write key; the first retirement timestamp is kept. */
  readonly retiredAt: string | null;
  readonly present: boolean;
}

interface RawRow {
  id: number;
  key_ref: string;
  version: number;
  kind: KeyKind;
  origin: KeyOrigin;
  label: string | null;
  fingerprint: string | null;
  created_at: string;
  retired_at: string | null;
  material_present: number;
}

const COLUMNS = `id, key_ref, version, kind, origin, label, fingerprint, created_at, retired_at, material_present FROM keys`;

function toRow(row: RawRow): KeyringRow {
  return {
    id: row.id,
    keyRef: row.key_ref,
    version: row.version,
    kind: row.kind,
    origin: row.origin,
    label: row.label,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    active: row.retired_at === null && row.material_present === 1,
    present: row.material_present === 1,
  };
}

export class KeyringRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(): readonly KeyringRow[] {
    return queryAll<RawRow>(this.db, `SELECT ${COLUMNS} ORDER BY id`).map(toRow);
  }

  get(id: number): KeyringRow | undefined {
    const row = queryGet<RawRow>(this.db, `SELECT ${COLUMNS} WHERE id = ?`, id);
    return row === undefined ? undefined : toRow(row);
  }

  /** The row an exported key file names — its (key_ref, version) pair. */
  byRef(keyRef: string, version: number): KeyringRow | undefined {
    const row = queryGet<RawRow>(this.db, `SELECT ${COLUMNS} WHERE key_ref = ? AND version = ?`, keyRef, version);
    return row === undefined ? undefined : toRow(row);
  }

  /** Everything sealed under the key, Trash included: removal strands all of it. */
  usage(id: number): KeyringUsage {
    const photos = queryGet<{ count: number; bytes: number | null }>(
      this.db,
      `SELECT count(*) AS count, sum(bytes) AS bytes FROM photos WHERE key_id = ?`,
      id,
    );
    const sidecars = queryGet<{ count: number; bytes: number | null }>(
      this.db,
      `SELECT count(*) AS count, sum(bytes) AS bytes FROM photo_sidecars WHERE key_id = ?`,
      id,
    );
    return {
      photos: photos?.count ?? 0,
      sidecars: sidecars?.count ?? 0,
      bytes: (photos?.bytes ?? 0) + (sidecars?.bytes ?? 0),
    };
  }

  /** Photo ids whose original or a sidecar is sealed under the key. */
  photoIds(id: number): readonly string[] {
    return queryAll<{ id: string }>(
      this.db,
      `SELECT id FROM photos WHERE key_id = @id
       UNION SELECT photo_id AS id FROM photo_sidecars WHERE key_id = @id
       ORDER BY id`,
      { id },
    ).map((row) => row.id);
  }

  lockedIds(): readonly number[] {
    return queryAll<{ id: number }>(this.db, `SELECT id FROM keys WHERE material_present = 0 ORDER BY id`).map((row) => row.id);
  }

  /** Upserts registry facts from custody. The label is user-owned and never
   * overwritten here; a stored fingerprint survives a key's absence. */
  register(entries: readonly KeyringRegistration[]): void {
    this.db.transaction(() => {
      for (const entry of entries) {
        runNamed(
          this.db,
          `INSERT INTO keys (id, wrapped_key, created_at, retired_at, kind, key_ref, version, fingerprint, origin, material_present)
           VALUES (@id, 'keystore-managed', @createdAt, @retiredAt, @kind, @keyRef, @version, @fingerprint, @origin, @present)
           ON CONFLICT (id) DO UPDATE SET
             retired_at = CASE WHEN excluded.retired_at IS NULL THEN NULL ELSE COALESCE(keys.retired_at, excluded.retired_at) END,
             kind = excluded.kind,
             key_ref = excluded.key_ref,
             version = excluded.version,
             fingerprint = COALESCE(excluded.fingerprint, keys.fingerprint),
             origin = excluded.origin,
             material_present = excluded.material_present`,
          { ...entry, present: entry.present ? 1 : 0 },
        );
      }
    })();
  }

  setPresent(id: number, present: boolean): void {
    run(this.db, `UPDATE keys SET material_present = ? WHERE id = ?`, present ? 1 : 0, id);
  }

  /** Marks every row the custody store no longer holds as absent. */
  markAbsentExcept(presentIds: readonly number[]): void {
    run(this.db, `UPDATE keys SET material_present = 0 WHERE id NOT IN (SELECT value FROM json_each(?))`, JSON.stringify(presentIds));
  }

  setLabel(id: number, label: string | null): void {
    run(this.db, `UPDATE keys SET label = ? WHERE id = ?`, label, id);
  }
}
