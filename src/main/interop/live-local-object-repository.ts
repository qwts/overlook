import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';

import { queryAll, queryGet, run, runNamed } from '../db/sql.js';
import { assertSafeInteropPath, type InteropObjectPage } from './transport.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

interface ObjectRow {
  path: string;
  sha256: string;
  bytes: number;
  ciphertext: Buffer;
}

export class LiveLocalObjectRepositoryError extends Error {
  override readonly name = 'LiveLocalObjectRepositoryError';
}

/** Durable, library-scoped ciphertext staging for one reviewed local route. */
export class LiveLocalObjectRepository {
  readonly #operationId: string;

  constructor(
    private readonly db: BetterSqlite3.Database,
    operationId: string,
  ) {
    this.#operationId = z.string().uuid().parse(operationId);
  }

  put(pathInput: string, bytesInput: Buffer, sha256Input: string): void {
    const path = assertSafeInteropPath(pathInput);
    const bytes = Buffer.from(bytesInput);
    const sha256 = sha256Schema.parse(sha256Input);
    try {
      this.db.transaction(() => {
        runNamed(
          this.db,
          `INSERT OR IGNORE INTO interop_local_objects (operation_id, path, sha256, bytes, ciphertext)
           VALUES (@operationId, @path, @sha256, @bytes, @ciphertext)`,
          { operationId: this.#operationId, path, sha256, bytes: bytes.length, ciphertext: bytes },
        );
        const stored = this.require(path);
        if (stored.sha256 !== sha256 || stored.bytes !== bytes.length || !stored.ciphertext.equals(bytes)) {
          throw new LiveLocalObjectRepositoryError('Live local object identity was replayed with different ciphertext.');
        }
      })();
    } finally {
      bytes.fill(0);
    }
  }

  get(pathInput: string): Buffer | undefined {
    const row = this.row(assertSafeInteropPath(pathInput));
    return row === undefined ? undefined : Buffer.from(row.ciphertext);
  }

  list(prefixInput: string, cursor: string | null): InteropObjectPage {
    const prefix = assertSafeInteropPath(prefixInput);
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new LiveLocalObjectRepositoryError('Invalid local object cursor.');
    const rows = queryAll<Pick<ObjectRow, 'path' | 'bytes'>>(
      this.db,
      `SELECT path, bytes FROM interop_local_objects
       WHERE operation_id = @operationId AND path LIKE @prefix ESCAPE '\\'
       ORDER BY path LIMIT 101 OFFSET @offset`,
      { operationId: this.#operationId, prefix: `${escapeLike(prefix)}%`, offset },
    );
    const page = rows.slice(0, 100);
    return {
      entries: page,
      nextCursor: rows.length > page.length ? String(offset + page.length) : null,
    };
  }

  delete(pathInput: string): void {
    run(
      this.db,
      'DELETE FROM interop_local_objects WHERE operation_id = ? AND path = ?',
      this.#operationId,
      assertSafeInteropPath(pathInput),
    );
  }

  clear(): void {
    run(this.db, 'DELETE FROM interop_local_objects WHERE operation_id = ?', this.#operationId);
  }

  usedBytes(): number {
    return (
      queryGet<{ total: number }>(
        this.db,
        'SELECT COALESCE(SUM(bytes), 0) AS total FROM interop_local_objects WHERE operation_id = ?',
        this.#operationId,
      )?.total ?? 0
    );
  }

  private row(path: string): ObjectRow | undefined {
    return queryGet<ObjectRow>(
      this.db,
      'SELECT path, sha256, bytes, ciphertext FROM interop_local_objects WHERE operation_id = ? AND path = ?',
      this.#operationId,
      path,
    );
  }

  private require(path: string): ObjectRow {
    const row = this.row(path);
    if (row === undefined) throw new LiveLocalObjectRepositoryError('Durable live local object was not written.');
    return { ...row, ciphertext: Buffer.from(row.ciphertext) };
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
