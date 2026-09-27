import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ulid } from '../import/ulid.js';

// The library's stable identity (ADR-0007 remote home, ADR-0017 §2 local
// identity): a ULID persisted as <dataDir>/library-id. The file is
// authoritative — it travels with the directory; the registry only caches it.
// Minted eagerly at registration/creation since #384 (previously lazily by
// the provider runtime on first backup need).

/** Pins a known id into a freshly created library directory (#384 create
 * flow) — same atomic write as the mint path. */
export function writeLibraryId(dataDir: string, id: string): void {
  const idPath = join(dataDir, 'library-id');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${idPath}.tmp`, id);
  renameSync(`${idPath}.tmp`, idPath);
}

const LIBRARY_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

/** The directory's ULID, or null when the file is missing, unreadable, or not a ULID.
 * Does not mint. Callers that need an id for a new library use `readOrMintLibraryId`. */
export function readStoredLibraryId(dataDir: string): string | null {
  const idPath = join(dataDir, 'library-id');
  if (!existsSync(idPath)) return null;
  try {
    const stored = readFileSync(idPath, 'utf8').trim();
    return LIBRARY_ULID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function readOrMintLibraryId(dataDir: string): string {
  const idPath = join(dataDir, 'library-id');
  if (existsSync(idPath)) {
    const stored = readFileSync(idPath, 'utf8').trim();
    // Only a well-formed ULID names an identity (PR #260 review): a
    // truncated/corrupted record would poison every future remote path
    // (even ''), so it is replaced — it never named a valid home.
    if (LIBRARY_ULID.test(stored)) {
      return stored;
    }
  }
  const id = ulid();
  mkdirSync(dataDir, { recursive: true });
  // Atomic like every other library record — a crash mid-write must not
  // leave a half-written id behind.
  writeFileSync(`${idPath}.tmp`, id);
  renameSync(`${idPath}.tmp`, idPath);
  return id;
}
