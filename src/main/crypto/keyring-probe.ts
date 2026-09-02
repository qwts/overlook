import { readFile, stat } from 'node:fs/promises';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { KEY_FILE_LENGTH, KeyFileError } from './key-file.js';
import type { BlobStore } from '../blobs/blob-store.js';
import { queryAll } from '../db/sql.js';

// Pure-Node halves of the keyring wiring (#517), kept apart from the
// Electron pickers so node:test exercises them against a real blob store.

const PROBE_CANDIDATES = 3;

/** A key file is exactly KEY_FILE_LENGTH bytes; nothing larger is buffered
 * (the recovery import's size check, security review P2-1). */
export async function readKeyFile(importPath: string): Promise<Buffer> {
  const stats = await stat(importPath);
  if (!stats.isFile() || stats.size !== KEY_FILE_LENGTH) throw new KeyFileError('invalid');
  return readFile(importPath);
}

/** Opens one object sealed under the key id with the candidate material —
 * a thumb first (small), else the original. No candidate means the key
 * matches nothing addressable, which the import ceremony refuses. */
export async function probeKeyAgainstStore(
  db: BetterSqlite3.Database,
  blobStore: Pick<BlobStore, 'getThumbStream' | 'getStream' | 'hasOriginal'>,
  keyId: number,
  key: Buffer,
): Promise<boolean> {
  const resolveKey = (candidate: number): Buffer | undefined => (candidate === keyId ? key : undefined);
  const rows = queryAll<{ id: string; content_hash: string; derivative_key: string }>(
    db,
    `SELECT id, content_hash, derivative_key FROM photos WHERE key_id = @keyId ORDER BY id LIMIT @limit`,
    { keyId, limit: PROBE_CANDIDATES },
  );
  for (const row of rows) {
    const openers = [
      () => blobStore.getThumbStream(row.derivative_key, 'thumb', resolveKey, row.id),
      () => (blobStore.hasOriginal(row.content_hash) ? blobStore.getStream(row.content_hash, resolveKey, row.id) : null),
    ];
    for (const open of openers) {
      try {
        const stream = open();
        if (stream === null) continue;
        for await (const _chunk of stream) {
          // Drain: every authenticated chunk proves the key.
        }
        return true;
      } catch {
        // The next candidate may still vouch for the key.
      }
    }
  }
  return false;
}
