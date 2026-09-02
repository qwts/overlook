import { rename, writeFile } from 'node:fs/promises';

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { probeKeyAgainstStore, readKeyFile } from './keyring-probe.js';
import { KeyringService } from './keyring-service.js';
import type { KeyStore } from './keystore.js';
import { pickKeyFileDestination, pickRecoveryKeyPath } from './recovery-key-picker.js';
import type { BlobStore } from '../blobs/blob-store.js';
import { KeyringRepository } from '../db/keyring-repository.js';

export interface KeyringFactoryOptions {
  readonly db: BetterSqlite3.Database;
  readonly keyStore: KeyStore;
  readonly blobStore: BlobStore;
  readonly harnessEnv: (name: string) => string | undefined;
  /** Drops one photo's decrypted derivatives when its custody changes. */
  readonly invalidate: (photoId: string) => void;
  /** Tells the renderer which rows to refetch as locked or unlocked. */
  readonly libraryChanged: (event: { photoIds: string[]; membership: 'library' }) => void;
}

/** Composition-root wiring for the keyring (#517): registry, custody, the
 * blob-store probe and the file pickers over the open library's parts. The
 * registry is reconciled before the service is handed out, so the current
 * key's row exists ahead of the first import (#90) and absent keys read as
 * locked from the first query. */
export function createKeyringService(options: KeyringFactoryOptions): KeyringService {
  const repo = new KeyringRepository(options.db);
  const service = new KeyringService({
    keyStore: () => options.keyStore,
    repo: () => repo,
    now: () => new Date().toISOString(),
    readKeyFile,
    writeFile: async (path, data) => {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, data);
      await rename(temporary, path);
    },
    pickExportDestination: (name) => pickKeyFileDestination(options.harnessEnv('OVERLOOK_KEY_EXPORT_DESTINATION'), name),
    pickImportSource: () => pickRecoveryKeyPath(options.harnessEnv('OVERLOOK_KEY_IMPORT_SOURCE')),
    probe: (keyId, key) => probeKeyAgainstStore(options.db, options.blobStore, keyId, key),
    custodyChanged: (photoIds) => {
      for (const id of photoIds) options.invalidate(id);
      options.libraryChanged({ photoIds: [...photoIds], membership: 'library' });
    },
    audit: (line) => console.info(`[overlook] ${line}`),
  });
  service.reconcile();
  return service;
}

/** The IPC accessor: opening the library builds the service, so ensure it first. */
export function requireKeyringService(ensureLibrary: () => unknown, current: () => KeyringService | undefined): KeyringService {
  ensureLibrary();
  const service = current();
  if (service === undefined) throw new Error('the keyring is unavailable before the library opens');
  return service;
}
