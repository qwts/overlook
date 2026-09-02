import { randomBytes } from 'node:crypto';

import { KeyFileError, keyFingerprintOf, openKeyFile, readKeyFileFacts, sealKeyFile } from './key-file.js';
import type { KeyRegistryFacts, KeyStore } from './keystore.js';
import type { KeyringRegistration, KeyringRepository, KeyringRow, KeyringUsage } from '../db/keyring-repository.js';
import { REMOVE_KEY_AUTHORIZATION } from '../../shared/destructive-actions.js';
import { keyFileName } from '../../shared/keyring/types.js';

// The keyring (#517, ADR-0032 §2): custody in the KeyStore, facts in the
// registry, and the ceremonies between them. Reconcile makes the registry
// agree with custody at every open; import validates a key file against an
// object it actually opens before taking it into custody; removal is the
// ADR-0023 ceremony whose tier depends on what the key still seals; export
// writes the password-sealed key file. Nothing here returns key bytes.

/** KEY #1 keys the SQLCipher database (src/main/index.ts) — never removable. */
export const DATABASE_KEY_ID = 1;

export type KeyringImportReason = 'invalid' | 'wrong-password' | 'matches-nothing' | 'no-matching-object' | 'mismatch';
export type KeyringRemoveReason = 'not-found' | 'not-present' | 'database-key' | 'write-key';

export interface KeyringEntry extends KeyringRow {
  readonly databaseKey: boolean;
  readonly usage: KeyringUsage;
}

export interface KeyringRemovePreflight {
  readonly allowed: boolean;
  readonly reason: KeyringRemoveReason | null;
  readonly tier: 'structural' | 'irreversible';
  readonly usage: KeyringUsage;
  readonly entry: KeyringEntry | null;
}

export interface KeyringImportOutcome {
  readonly outcome: 'imported' | 'already-present' | 'refused';
  readonly keyId: number | null;
  readonly fingerprint: string | null;
  readonly unlocked: number;
  readonly reason: KeyringImportReason | null;
}

export class KeyringError extends Error {
  override readonly name = 'KeyringError';
}

export class KeyringAuthorizationError extends Error {
  override readonly name = 'KeyringAuthorizationError';
}

export interface KeyringDeps {
  readonly keyStore: () => Pick<KeyStore, 'listKeys' | 'hasKey' | 'keyBytes' | 'adoptRegistryFacts' | 'importKey' | 'removeKey'>;
  readonly repo: () => KeyringRepository;
  readonly now: () => string;
  /** Size-checked read of a candidate key file; rejects anything that is not exactly one. */
  readonly readKeyFile: (path: string) => Promise<Buffer>;
  /** Atomic write of the sealed export. */
  readonly writeFile: (path: string, data: Buffer) => Promise<void>;
  readonly pickExportDestination: (suggestedName: string) => Promise<string | null>;
  readonly pickImportSource: () => Promise<string | null>;
  /** Proves the candidate opens at least one object sealed under the key id. */
  readonly probe: (keyId: number, key: Buffer) => Promise<boolean>;
  /** Rows whose custody just changed: caches drop, the renderer refetches. */
  readonly custodyChanged: (photoIds: readonly string[]) => void;
  readonly audit: (line: string) => void;
}

function refused(reason: KeyringImportReason): KeyringImportOutcome {
  return { outcome: 'refused', keyId: null, fingerprint: null, unlocked: 0, reason };
}

function fingerprintAndWipe(key: Buffer | undefined): string | null {
  if (key === undefined) return null;
  try {
    return keyFingerprintOf(key);
  } finally {
    key.fill(0);
  }
}

export class KeyringService {
  constructor(private readonly deps: KeyringDeps) {}

  /** Registers every custody record and marks the rest absent. Pre-#517
   * records adopt the row's reference when the migration minted one, so a
   * library keeps the identity its manifests may already carry. */
  reconcile(): readonly number[] {
    const store = this.deps.keyStore();
    const repo = this.deps.repo();
    const now = this.deps.now();
    const entries = store.listKeys().map((key): KeyringRegistration => {
      let facts: KeyRegistryFacts;
      if (key.keyRef === undefined) {
        const row = repo.get(key.id);
        facts = {
          keyRef: row?.keyRef ?? randomBytes(16).toString('hex'),
          version: row?.version ?? 1,
          kind: row?.kind ?? 'library',
          origin: row?.origin ?? 'local',
        };
        store.adoptRegistryFacts(key.id, facts);
      } else {
        facts = { keyRef: key.keyRef, version: key.version ?? 1, kind: key.kind ?? 'library', origin: key.origin ?? 'local' };
      }
      return {
        id: key.id,
        ...facts,
        fingerprint: fingerprintAndWipe(store.keyBytes(key.id)),
        createdAt: key.createdAt,
        retiredAt: key.status === 'active' ? null : now,
        present: true,
      };
    });
    repo.register(entries);
    repo.markAbsentExcept(entries.map((entry) => entry.id));
    return repo.lockedIds();
  }

  list(): readonly KeyringEntry[] {
    const repo = this.deps.repo();
    return repo.list().map((row) => this.entry(row));
  }

  private entry(row: KeyringRow): KeyringEntry {
    return { ...row, databaseKey: row.id === DATABASE_KEY_ID, usage: this.deps.repo().usage(row.id) };
  }

  removePreflight(id: number): KeyringRemovePreflight {
    const row = this.deps.repo().get(id);
    const empty = { photos: 0, sidecars: 0, bytes: 0 };
    if (row === undefined) return { allowed: false, reason: 'not-found', tier: 'structural', usage: empty, entry: null };
    const entry = this.entry(row);
    const tier = entry.usage.photos + entry.usage.sidecars > 0 ? 'irreversible' : 'structural';
    const reason: KeyringRemoveReason | null = !row.present
      ? 'not-present'
      : id === DATABASE_KEY_ID
        ? 'database-key'
        : row.active
          ? 'write-key'
          : null;
    return { allowed: reason === null, reason, tier, usage: entry.usage, entry };
  }

  /** The removal ceremony. Tier D needs the authorization literal the
   * confirmation dialog carries; a refused key changes nothing. */
  remove(
    id: number,
    authorization?: string,
  ): { readonly removed: boolean; readonly reason: KeyringRemoveReason | null; readonly locked: number } {
    const plan = this.removePreflight(id);
    if (!plan.allowed) return { removed: false, reason: plan.reason, locked: 0 };
    if (plan.tier === 'irreversible' && authorization !== REMOVE_KEY_AUTHORIZATION) {
      throw new KeyringAuthorizationError('removing a key that still seals objects requires the Remove key authorization');
    }
    const repo = this.deps.repo();
    this.deps.keyStore().removeKey(id);
    repo.setPresent(id, false);
    const photoIds = repo.photoIds(id);
    this.deps.audit(
      `KEYRING-REMOVE key=${String(id)} ref=${plan.entry?.keyRef ?? '?'} photos=${String(plan.usage.photos)} sidecars=${String(plan.usage.sidecars)} bytes=${String(plan.usage.bytes)}`,
    );
    this.deps.custodyChanged(photoIds);
    return { removed: true, reason: null, locked: photoIds.length };
  }

  async exportKey(id: number, password: string): Promise<string | null> {
    const row = this.deps.repo().get(id);
    const key = this.deps.keyStore().keyBytes(id);
    if (row === undefined || key === undefined) throw new KeyringError(`key ${String(id)} is not present on this device`);
    try {
      const destination = await this.deps.pickExportDestination(keyFileName(row.keyRef, row.version));
      if (destination === null) return null;
      await this.deps.writeFile(destination, sealKeyFile(key, { kind: row.kind, keyRef: row.keyRef, version: row.version }, password));
      this.deps.audit(`KEYRING-EXPORT key=${String(id)} ref=${row.keyRef} version=${String(row.version)}`);
      return destination;
    } finally {
      key.fill(0);
    }
  }

  pickFile(): Promise<string | null> {
    return this.deps.pickImportSource();
  }

  /** The import ceremony (ADR-0032 §2): the file's reference must name a
   * registry row, the password must open it, and — before custody — the
   * key must open an object sealed under that row. Identical material
   * already held is idempotent; different material is refused. */
  async importKey(path: string, password: string): Promise<KeyringImportOutcome> {
    let data: Buffer;
    try {
      data = await this.deps.readKeyFile(path);
    } catch {
      return refused('invalid');
    }
    let facts: ReturnType<typeof readKeyFileFacts>;
    try {
      facts = readKeyFileFacts(data);
    } catch {
      return refused('invalid');
    }
    const repo = this.deps.repo();
    const row = repo.byRef(facts.keyRef, facts.version);
    if (row === undefined || row.kind !== facts.kind) return refused('matches-nothing');
    let key: Buffer;
    try {
      key = openKeyFile(data, password).key;
    } catch (error) {
      return refused(error instanceof KeyFileError ? error.reason : 'invalid');
    }
    try {
      const store = this.deps.keyStore();
      if (!store.hasKey(row.id) && !(await this.deps.probe(row.id, key))) return refused('no-matching-object');
      const registry: KeyRegistryFacts = { keyRef: facts.keyRef, version: facts.version, kind: facts.kind, origin: 'imported' };
      const result = store.importKey(row.id, key, registry);
      if (result === 'mismatch') return refused('mismatch');
      const fingerprint = keyFingerprintOf(key);
      if (result === 'already-present') return { outcome: 'already-present', keyId: row.id, fingerprint, unlocked: 0, reason: null };
      repo.register([{ id: row.id, ...registry, fingerprint, createdAt: row.createdAt, retiredAt: this.deps.now(), present: true }]);
      const photoIds = repo.photoIds(row.id);
      this.deps.audit(
        `KEYRING-IMPORT key=${String(row.id)} ref=${facts.keyRef} version=${String(facts.version)} unlocked=${String(photoIds.length)}`,
      );
      this.deps.custodyChanged(photoIds);
      return { outcome: 'imported', keyId: row.id, fingerprint, unlocked: photoIds.length, reason: null };
    } finally {
      key.fill(0);
    }
  }

  setLabel(id: number, label: string): void {
    const trimmed = label.trim();
    this.deps.repo().setLabel(id, trimmed === '' ? null : trimmed);
  }
}
