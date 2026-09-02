import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH_TAG_BYTES = 16;
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EnvelopeKey, KeyResolver } from './envelope.js';
import type { KeyKind, KeyOrigin } from '../../shared/keyring/types.js';

// Master-key + versioned-library-key lifecycle per ADR-0004 §custody/rotation
// (#68). The Electron safeStorage dependency is injected so node:test proves
// restart persistence and failure paths against a fake; src/main/index wires
// the real one.

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class KeyCustodyError extends Error {
  override readonly name = 'KeyCustodyError';
}

/** Non-secret registry facts a custody record carries (ADR-0032 §2). Absent
 * on records written before #517; the keyring reconciles them at open. */
export interface KeyRegistryFacts {
  readonly keyRef: string;
  readonly version: number;
  readonly kind: KeyKind;
  readonly origin: KeyOrigin;
}

export interface KeyDisplay {
  /** The Inspector's "KEY #N". */
  readonly id: number;
  readonly keyRef?: string | undefined;
  readonly version?: number | undefined;
  readonly kind?: KeyKind | undefined;
  readonly origin?: KeyOrigin | undefined;
  readonly createdAt: string;
  /** `held`: imported custody that is never the write key (#517). */
  readonly status: 'active' | 'retired' | 'held';
}

export type KeyImportResult = 'imported' | 'already-present' | 'mismatch';

export interface WrappedKeyRecord extends KeyDisplay {
  /** base64(nonce | tag | ciphertext) — the 32 key bytes GCM-wrapped by the
   * master key with AAD = key id. */
  readonly wrappedKey: string;
  /** Exclusive high-water mark for durably reserved 64-bit envelope prefixes. */
  readonly nonceHighWater?: string | undefined;
}

export interface KeysFile {
  readonly version: 1;
  readonly keys: readonly WrappedKeyRecord[];
}

const MASTER_FILE = 'master.key';
const KEYS_FILE = 'keys.json';
const NONCE_PREFIX_LIMIT = 1n << 64n;
const NONCE_RESERVATION_SIZE = 1024n;

function parseNonceHighWater(value: string, keyId: number): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new KeyCustodyError(`key ${String(keyId)} nonce high-water mark is malformed`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > NONCE_PREFIX_LIMIT) {
    throw new KeyCustodyError(`key ${String(keyId)} nonce high-water mark is outside the 64-bit prefix space`);
  }
  return parsed;
}

function legacyNonceStart(): bigint {
  const seed = randomBytes(8);
  // Keep migrated keys in the upper half, away from new keys that begin at
  // zero, while reserving at least 2^62 values before exhaustion.
  seed[0] = ((seed[0] ?? 0) & 0x3f) | 0x80;
  return seed.readBigUInt64BE();
}

function wrapKey(masterKey: Buffer, keyId: number, keyBytes: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce, { authTagLength: AUTH_TAG_BYTES });
  const aad = Buffer.alloc(4);
  aad.writeUInt32BE(keyId, 0);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Recovery import (#240) validates a candidate master against stored key
 * rows without opening the whole store. */
export function unwrapStoredKey(masterKey: Buffer, keyId: number, wrapped: string): Buffer {
  return unwrapKey(masterKey, keyId, wrapped);
}

/** Reads keys.json for out-of-store consumers (#240); null when absent or
 * unparseable. */
export function readKeysFile(dataDir: string): KeysFile | null {
  const keysPath = join(dataDir, KEYS_FILE);
  if (!existsSync(keysPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(keysPath, 'utf8')) as KeysFile;
  } catch {
    return null;
  }
}

function unwrapKey(masterKey: Buffer, keyId: number, wrapped: string): Buffer {
  const raw = Buffer.from(wrapped, 'base64');
  if (raw.length < 12 + 16) {
    throw new KeyCustodyError(`wrapped key ${String(keyId)} is malformed`);
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, raw.subarray(0, 12), { authTagLength: AUTH_TAG_BYTES });
  const aad = Buffer.alloc(4);
  aad.writeUInt32BE(keyId, 0);
  decipher.setAAD(aad);
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  } catch {
    throw new KeyCustodyError(`wrapped key ${String(keyId)} failed authentication (wrong master key or tampered store)`);
  }
}

/** Atomic-ish write: temp file + rename, same volume by construction. */
function writeFileAtomic(path: string, data: string | Buffer): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

export interface KeyStoreOptions {
  readonly safeStorage: SafeStorageLike;
  /** Library data directory (ADR-0005 layout); created if missing. */
  readonly dataDir: string;
  /** Injected for tests; defaults to wall clock. */
  readonly now?: () => Date;
}

export class KeyStore {
  private readonly nextNonceByKey = new Map<number, bigint>();

  private constructor(
    private readonly options: KeyStoreOptions,
    private readonly masterKey: Buffer,
    private records: readonly WrappedKeyRecord[],
    private keys: Map<number, Buffer>,
  ) {}

  /** First run generates the master key + KEY #1; later runs load + unwrap. */
  static open(options: KeyStoreOptions): KeyStore {
    if (!options.safeStorage.isEncryptionAvailable()) {
      throw new KeyCustodyError('OS keychain is unavailable; refusing to store the master key without it (no plaintext fallback)');
    }
    mkdirSync(options.dataDir, { recursive: true });
    const masterPath = join(options.dataDir, MASTER_FILE);
    const isFirstRun = !existsSync(masterPath);
    let masterKey: Buffer;
    if (!isFirstRun) {
      const persisted = readFileSync(masterPath);
      if (persisted.subarray(0, 4).toString('ascii') === 'OVLK') {
        throw new KeyCustodyError('app lock is configured; password authorization is required before opening the key store');
      }
      let decoded: string;
      try {
        decoded = options.safeStorage.decryptString(persisted);
      } catch {
        throw new KeyCustodyError('the stored master key could not be unwrapped by the OS keychain');
      }
      masterKey = Buffer.from(decoded, 'base64');
      if (masterKey.length !== 32) {
        throw new KeyCustodyError('the stored master key is malformed');
      }
    } else {
      masterKey = randomBytes(32);
      writeFileAtomic(masterPath, options.safeStorage.encryptString(masterKey.toString('base64')));
    }

    return KeyStore.fromMaster(options, masterKey, isFirstRun);
  }

  /** Opens an app-locked library after ADR-0013 has authenticated and released
   * the master. The caller retains ownership of its input Buffer. */
  static openWithMaster(options: KeyStoreOptions, authorizedMaster: Buffer): KeyStore {
    if (authorizedMaster.length !== 32) throw new KeyCustodyError('authorized master key is malformed');
    mkdirSync(options.dataDir, { recursive: true });
    return KeyStore.fromMaster(options, Buffer.from(authorizedMaster), false);
  }

  private static fromMaster(options: KeyStoreOptions, masterKey: Buffer, isFirstRun: boolean): KeyStore {
    const keysPath = join(options.dataDir, KEYS_FILE);
    let records: readonly WrappedKeyRecord[];
    if (existsSync(keysPath)) {
      const parsed = JSON.parse(readFileSync(keysPath, 'utf8')) as KeysFile;
      records = parsed.keys;
    } else {
      records = [];
    }

    // An existing master key with no library keys means the keys file was
    // lost or emptied. Regenerating KEY #1 here would mint DIFFERENT bytes
    // under an id existing envelopes already reference — refuse instead
    // (PR #148 review).
    if (!isFirstRun && records.length === 0) {
      throw new KeyCustodyError(
        'the master key exists but no library keys were found; refusing to regenerate KEY #1 over an existing store (keys.json lost or corrupted)',
      );
    }
    let migratedNonceState = false;
    records = records.map((record) => {
      if (record.nonceHighWater !== undefined) {
        parseNonceHighWater(record.nonceHighWater, record.id);
        return record;
      }
      migratedNonceState = true;
      return { ...record, nonceHighWater: legacyNonceStart().toString() };
    });
    const store = new KeyStore(options, masterKey, records, new Map());
    for (const record of records) {
      store.keys.set(record.id, unwrapKey(masterKey, record.id, record.wrappedKey));
      store.nextNonceByKey.set(record.id, parseNonceHighWater(record.nonceHighWater ?? '0', record.id));
    }
    if (isFirstRun) {
      store.createKey();
    } else if (migratedNonceState) {
      store.persist();
    }
    return store;
  }

  private persist(): void {
    const file: KeysFile = { version: 1, keys: this.records };
    writeFileAtomic(join(this.options.dataDir, KEYS_FILE), JSON.stringify(file, null, 2));
  }

  private createKey(): EnvelopeKey {
    const id = this.records.reduce((max, record) => Math.max(max, record.id), 0) + 1;
    const keyBytes = randomBytes(32);
    const createdAt = (this.options.now?.() ?? new Date()).toISOString();
    const record: WrappedKeyRecord = {
      id,
      createdAt,
      status: 'active',
      wrappedKey: wrapKey(this.masterKey, id, keyBytes),
      nonceHighWater: '0',
      keyRef: randomBytes(16).toString('hex'),
      version: 1,
      kind: 'library',
      origin: 'local',
    };
    this.records = [
      ...this.records.map((existing) => (existing.status === 'active' ? { ...existing, status: 'retired' as const } : existing)),
      record,
    ];
    this.keys.set(id, keyBytes);
    this.nextNonceByKey.set(id, 0n);
    this.persist();
    return this.envelopeKey(id, keyBytes);
  }

  private envelopeKey(id: number, key: Buffer): EnvelopeKey {
    return { id, key, reserveNoncePrefix: () => this.reserveNoncePrefix(id) };
  }

  private reserveNoncePrefix(keyId: number): Buffer {
    const next = this.nextNonceByKey.get(keyId);
    if (next === undefined) {
      throw new KeyCustodyError(`key ${String(keyId)} has no nonce reservation state`);
    }
    if (next >= NONCE_PREFIX_LIMIT) {
      throw new KeyCustodyError(`key ${String(keyId)} exhausted its 64-bit nonce prefix space; rotate the library key`);
    }
    const record = this.records.find((candidate) => candidate.id === keyId);
    if (record === undefined) {
      throw new KeyCustodyError(`key ${String(keyId)} has no custody record`);
    }
    const highWater = parseNonceHighWater(record.nonceHighWater ?? '0', keyId);
    if (next >= highWater) {
      const reservedUntil = next + NONCE_RESERVATION_SIZE > NONCE_PREFIX_LIMIT ? NONCE_PREFIX_LIMIT : next + NONCE_RESERVATION_SIZE;
      const previousRecords = this.records;
      this.records = previousRecords.map((existing) =>
        existing.id === keyId ? { ...existing, nonceHighWater: reservedUntil.toString() } : existing,
      );
      // Persist the exclusive bound before returning any value in the range.
      // A crash may skip values, but can never make one reusable.
      try {
        this.persist();
      } catch (error) {
        this.records = previousRecords;
        throw error;
      }
    }
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64BE(next);
    this.nextNonceByKey.set(keyId, next + 1n);
    return prefix;
  }

  /** The write key — the newest active key (ADR-0004 rotation model). */
  currentKey(): EnvelopeKey {
    const active = this.records.find((record) => record.status === 'active');
    if (active === undefined) {
      throw new KeyCustodyError('key store has no active key');
    }
    const key = this.keys.get(active.id);
    if (key === undefined) {
      throw new KeyCustodyError(`active key ${String(active.id)} is not unwrapped`);
    }
    return this.envelopeKey(active.id, key);
  }

  /** Resolver for decrypt streams — retired keys keep decrypting. */
  resolver(): KeyResolver {
    return (keyId) => this.keys.get(keyId);
  }

  /** Rotation scaffold: new writes pick up KEY #N+1; no re-encrypt sweep (ADR-0004 v1). */
  rotate(): EnvelopeKey {
    return this.createKey();
  }

  /** Metadata for the Inspector's "KEY #N" row and the keyring registry. */
  listKeys(): readonly KeyDisplay[] {
    return this.records.map(({ wrappedKey: _wrapped, nonceHighWater: _nonce, ...display }) => display);
  }

  hasKey(id: number): boolean {
    return this.keys.has(id);
  }

  /** A copy of one unwrapped data key for export (#517). Callers wipe it. */
  keyBytes(id: number): Buffer | undefined {
    const key = this.keys.get(id);
    return key === undefined ? undefined : Buffer.from(key);
  }

  /** Attaches registry facts to a pre-#517 record; a no-op once present. */
  adoptRegistryFacts(id: number, facts: KeyRegistryFacts): void {
    const record = this.records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new KeyCustodyError(`key ${String(id)} has no custody record`);
    if (record.keyRef !== undefined) return;
    this.records = this.records.map((existing) => (existing.id === id ? { ...existing, ...facts } : existing));
    this.persist();
  }

  /** Takes an imported data key into custody under the registry id its
   * (key_ref, version) resolved to. Idempotent for identical material;
   * different material under a held id is refused, never replaced. */
  importKey(id: number, keyBytes: Buffer, facts: KeyRegistryFacts): KeyImportResult {
    if (keyBytes.length !== 32) throw new KeyCustodyError('imported key must be 32 bytes');
    const held = this.keys.get(id);
    if (held !== undefined) return timingSafeEqual(held, keyBytes) ? 'already-present' : 'mismatch';
    if (this.records.some((record) => record.id === id)) {
      throw new KeyCustodyError(`key ${String(id)} has a custody record without material`);
    }
    const record: WrappedKeyRecord = {
      id,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      status: 'held',
      wrappedKey: wrapKey(this.masterKey, id, keyBytes),
      nonceHighWater: '0',
      ...facts,
    };
    this.records = [...this.records, record].sort((left, right) => left.id - right.id);
    this.keys.set(id, Buffer.from(keyBytes));
    this.nextNonceByKey.set(id, 0n);
    this.persist();
    return 'imported';
  }

  /** Drops a key's material and custody record (#517 removal ceremony).
   * The write key can never be removed: the store must always seal. */
  removeKey(id: number): void {
    const record = this.records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new KeyCustodyError(`key ${String(id)} has no custody record`);
    if (record.status === 'active') throw new KeyCustodyError(`key ${String(id)} is the write key and cannot be removed`);
    const previousRecords = this.records;
    this.records = this.records.filter((existing) => existing.id !== id);
    try {
      this.persist();
    } catch (error) {
      this.records = previousRecords;
      throw error;
    }
    this.keys.get(id)?.fill(0);
    this.keys.delete(id);
    this.nextNonceByKey.delete(id);
  }

  /** Wrapped library-key records for the recovery bootstrap (#289). They
   * remain AES-GCM sealed by the master key; callers never receive raw data
   * keys through this export. */
  exportWrappedKeys(): readonly WrappedKeyRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Recovery backup material (#240): a copy of the master key for sealing
   * into the password-encrypted recovery file. Handle and drop promptly. */
  masterKeyBytes(): Buffer {
    return Buffer.from(this.masterKey);
  }

  /** Revokes every in-memory key copy owned by this store. */
  close(): void {
    this.masterKey.fill(0);
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.nextNonceByKey.clear();
  }
}
