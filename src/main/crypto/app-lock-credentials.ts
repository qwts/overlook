import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { SafeStorageLike } from './keystore.js';
import { assertStrongPassword, createPasswordSaltV1, derivePasswordKeyV1, PASSWORD_KDF_V1 } from './password-kdf.js';

const MAGIC = Buffer.from('OVLK', 'ascii');
const MASTER_FILE = 'master.key';
const CONFIGURED_MARKER_FILE = 'app-lock.configured';
const CONFIGURED_MARKER = Buffer.from('OVLK1\n', 'ascii');
const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface CredentialAnchor {
  readonly libraryId: string;
  readonly generation: number;
  readonly recordHash: string;
}

export interface CredentialAnchorStore {
  isAvailable(): boolean;
  read(): CredentialAnchor | null;
  write(anchor: CredentialAnchor): void;
  clear(): void;
}

export type AppLockStatus =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'locked'; readonly libraryId: string }
  | {
      readonly state: 'recovery-required';
      readonly reason: 'anchor-mismatch' | 'anchor-missing' | 'anchor-unavailable' | 'invalid-record';
    };

export type UnlockResult =
  { readonly ok: true; readonly masterKey: Buffer } | { readonly ok: false; readonly reason: 'wrong-password' | 'recovery-required' };

export type UnlockKeyResult =
  { readonly ok: true; readonly unlockKey: Buffer } | { readonly ok: false; readonly reason: 'wrong-password' | 'recovery-required' };

export type MasterReleaseResult =
  { readonly ok: true; readonly masterKey: Buffer } | { readonly ok: false; readonly reason: 'invalid-unlock-key' | 'recovery-required' };

export interface AppLockCredentialStoreOptions {
  readonly dataDir: string;
  readonly anchorStore: CredentialAnchorStore;
  readonly safeStorage: SafeStorageLike;
}

export interface ConfigureAppLockInput {
  readonly libraryId: string;
  readonly password: string;
  readonly masterKey: Buffer;
}

const canonicalBase64 = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}, 'must be canonical base64');

const slotSchema = z
  .object({
    algorithm: z.literal('AES-256-GCM'),
    nonce: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === NONCE_BYTES),
    ciphertextAndTag: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === KEY_BYTES + TAG_BYTES),
  })
  .strict();

const recordSchema = z
  .object({
    version: z.literal(VERSION),
    libraryId: z.string().min(1).max(256),
    generation: z.number().int().positive(),
    kdf: z
      .object({
        name: z.literal('scrypt'),
        N: z.literal(PASSWORD_KDF_V1.N),
        r: z.literal(PASSWORD_KDF_V1.r),
        p: z.literal(PASSWORD_KDF_V1.p),
        salt: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === PASSWORD_KDF_V1.saltBytes),
      })
      .strict(),
    passwordSlot: slotSchema,
    masterSlot: slotSchema,
  })
  .strict();

type AppLockRecord = z.output<typeof recordSchema>;
type SealedSlot = z.output<typeof slotSchema>;

function writeFileAtomic(path: string, data: Buffer): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

function recordBytes(record: AppLockRecord): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(record), 'utf8')]);
}

function recordHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function parseRecord(raw: Buffer): AppLockRecord | null {
  if (raw.length <= MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  try {
    const json = raw.subarray(MAGIC.length).toString('utf8');
    const parsed = recordSchema.parse(JSON.parse(json) as unknown);
    return JSON.stringify(parsed) === json ? parsed : null;
  } catch {
    return null;
  }
}

function aad(record: Pick<AppLockRecord, 'libraryId' | 'generation'>, slot: 'password' | 'master'): Buffer {
  return Buffer.from(`OVLK|${String(VERSION)}|${record.libraryId}|${String(record.generation)}|${slot}|AES-256-GCM`, 'utf8');
}

function seal(key: Buffer, plaintext: Buffer, associatedData: Buffer): SealedSlot {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: 'AES-256-GCM', nonce: nonce.toString('base64'), ciphertextAndTag: ciphertext.toString('base64') };
}

function open(key: Buffer, slot: SealedSlot, associatedData: Buffer): Buffer {
  const nonce = Buffer.from(slot.nonce, 'base64');
  const sealed = Buffer.from(slot.ciphertextAndTag, 'base64');
  const ciphertext = sealed.subarray(0, -TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(sealed.subarray(-TAG_BYTES));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function validateInput({ libraryId, password, masterKey }: ConfigureAppLockInput): void {
  if (libraryId.length < 1 || libraryId.length > 256) throw new Error('library id is invalid');
  assertStrongPassword(password);
  if (masterKey.length !== KEY_BYTES) throw new Error('master key must be 32 bytes');
}

async function createRecord(input: ConfigureAppLockInput, generation: number): Promise<AppLockRecord> {
  validateInput(input);
  const salt = createPasswordSaltV1();
  const passwordKey = await derivePasswordKeyV1(input.password, salt);
  const unlockKey = randomBytes(KEY_BYTES);
  const header = { libraryId: input.libraryId, generation };
  try {
    return {
      version: VERSION,
      libraryId: input.libraryId,
      generation,
      kdf: { name: 'scrypt', N: PASSWORD_KDF_V1.N, r: PASSWORD_KDF_V1.r, p: PASSWORD_KDF_V1.p, salt: salt.toString('base64') },
      passwordSlot: seal(passwordKey, unlockKey, aad(header, 'password')),
      masterSlot: seal(unlockKey, input.masterKey, aad(header, 'master')),
    };
  } finally {
    passwordKey.fill(0);
    unlockKey.fill(0);
  }
}

/** Versioned password custody for ADR-0013. The anchor adapter is injected so
 * the runtime can use a real OS credential store and tests remain deterministic. */
export class AppLockCredentialStore {
  private readonly masterPath: string;
  private readonly pendingPath: string;
  private readonly configuredMarkerPath: string;

  constructor(private readonly options: AppLockCredentialStoreOptions) {
    this.masterPath = join(options.dataDir, MASTER_FILE);
    this.pendingPath = `${this.masterPath}.pending`;
    this.configuredMarkerPath = join(options.dataDir, CONFIGURED_MARKER_FILE);
  }

  status(): AppLockStatus {
    this.reconcilePendingTransition();
    if (!existsSync(this.masterPath)) {
      const pendingExists = existsSync(this.pendingPath);
      const configuredBefore = existsSync(this.configuredMarkerPath);
      if (!this.options.anchorStore.isAvailable()) {
        return pendingExists || configuredBefore ? { state: 'recovery-required', reason: 'anchor-unavailable' } : { state: 'unconfigured' };
      }
      const anchor = this.options.anchorStore.read();
      if (anchor !== null) return { state: 'recovery-required', reason: 'anchor-mismatch' };
      return pendingExists || configuredBefore ? { state: 'recovery-required', reason: 'anchor-missing' } : { state: 'unconfigured' };
    }
    const raw = readFileSync(this.masterPath);
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      const configuredBefore = existsSync(this.configuredMarkerPath);
      if (!this.options.anchorStore.isAvailable()) {
        return configuredBefore ? { state: 'recovery-required', reason: 'anchor-unavailable' } : { state: 'unconfigured' };
      }
      const anchor = this.options.anchorStore.read();
      if (anchor === null) {
        return configuredBefore ? { state: 'recovery-required', reason: 'anchor-missing' } : { state: 'unconfigured' };
      }
      if (anchor.recordHash === recordHash(raw)) {
        this.completeRemoval();
        return { state: 'unconfigured' };
      }
      return { state: 'recovery-required', reason: 'anchor-mismatch' };
    }
    const record = parseRecord(raw);
    if (record === null) return { state: 'recovery-required', reason: 'invalid-record' };
    if (!this.options.anchorStore.isAvailable()) return { state: 'recovery-required', reason: 'anchor-unavailable' };
    const anchor = this.options.anchorStore.read();
    if (anchor === null) return { state: 'recovery-required', reason: 'anchor-missing' };
    if (anchor.libraryId !== record.libraryId || anchor.generation !== record.generation || anchor.recordHash !== recordHash(raw)) {
      return { state: 'recovery-required', reason: 'anchor-mismatch' };
    }
    this.writeConfiguredMarker();
    return { state: 'locked', libraryId: record.libraryId };
  }

  async configure(input: ConfigureAppLockInput): Promise<void> {
    if (this.status().state !== 'unconfigured') throw new Error('app lock is already configured');
    await this.replaceRecord(input);
  }

  async unlock(password: string): Promise<UnlockResult> {
    const released = await this.releaseUnlockKey(password);
    if (!released.ok) return released;
    try {
      const master = this.unlockWithKey(released.unlockKey);
      return master.ok ? master : { ok: false, reason: 'recovery-required' };
    } finally {
      released.unlockKey.fill(0);
    }
  }

  /** Password authentication releases U only. The caller owns and must wipe
   * the returned buffer; biometric opt-in stores U under native access control. */
  async releaseUnlockKey(password: string): Promise<UnlockKeyResult> {
    if (this.status().state !== 'locked') return { ok: false, reason: 'recovery-required' };
    if (password.length < 1 || password.length > 1024) return { ok: false, reason: 'wrong-password' };
    const record = parseRecord(readFileSync(this.masterPath));
    if (record === null) return { ok: false, reason: 'recovery-required' };
    const passwordKey = await derivePasswordKeyV1(password, Buffer.from(record.kdf.salt, 'base64'));
    let unlockKey: Buffer | undefined;
    try {
      unlockKey = open(passwordKey, record.passwordSlot, aad(record, 'password'));
      if (unlockKey.length !== KEY_BYTES) return { ok: false, reason: 'recovery-required' };
      return { ok: true, unlockKey };
    } catch {
      return { ok: false, reason: 'wrong-password' };
    } finally {
      passwordKey.fill(0);
      if (unlockKey !== undefined && unlockKey.length !== KEY_BYTES) unlockKey.fill(0);
    }
  }

  /** Opens U → M only after password or native biometric authority released U. */
  unlockWithKey(unlockKey: Buffer): MasterReleaseResult {
    if (this.status().state !== 'locked') return { ok: false, reason: 'recovery-required' };
    if (unlockKey.length !== KEY_BYTES) return { ok: false, reason: 'invalid-unlock-key' };
    const record = parseRecord(readFileSync(this.masterPath));
    if (record === null) return { ok: false, reason: 'recovery-required' };
    try {
      const masterKey = open(unlockKey, record.masterSlot, aad(record, 'master'));
      return masterKey.length === KEY_BYTES ? { ok: true, masterKey } : { ok: false, reason: 'recovery-required' };
    } catch {
      return { ok: false, reason: 'invalid-unlock-key' };
    }
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<boolean> {
    const unlocked = await this.unlock(currentPassword);
    if (!unlocked.ok) return false;
    const record = parseRecord(readFileSync(this.masterPath));
    if (record === null) {
      unlocked.masterKey.fill(0);
      return false;
    }
    try {
      await this.replaceRecord({ libraryId: record.libraryId, password: nextPassword, masterKey: unlocked.masterKey });
      return true;
    } finally {
      unlocked.masterKey.fill(0);
    }
  }

  async recover(input: ConfigureAppLockInput): Promise<void> {
    await this.replaceRecord(input);
  }

  async remove(password: string): Promise<boolean> {
    const unlocked = await this.unlock(password);
    if (!unlocked.ok) return false;
    try {
      if (!this.options.safeStorage.isEncryptionAvailable()) throw new Error('OS keychain is unavailable');
      mkdirSync(this.options.dataDir, { recursive: true });
      const legacy = this.options.safeStorage.encryptString(unlocked.masterKey.toString('base64'));
      const current = parseRecord(readFileSync(this.masterPath));
      if (current === null) throw new Error('app-lock record is unavailable');
      const anchor = {
        libraryId: current.libraryId,
        generation: Math.max(current.generation, this.options.anchorStore.read()?.generation ?? 0) + 1,
        recordHash: recordHash(legacy),
      };
      writeFileAtomic(this.pendingPath, legacy);
      this.options.anchorStore.write(anchor);
      renameSync(this.pendingPath, this.masterPath);
      this.completeRemoval();
      return true;
    } finally {
      unlocked.masterKey.fill(0);
    }
  }

  anchor(): CredentialAnchor | null {
    return this.options.anchorStore.read();
  }

  private async replaceRecord(input: ConfigureAppLockInput): Promise<void> {
    if (!this.options.anchorStore.isAvailable()) throw new Error('OS credential store is unavailable');
    const current = parseRecord(existsSync(this.masterPath) ? readFileSync(this.masterPath) : Buffer.alloc(0));
    const generation = Math.max(current?.generation ?? 0, this.options.anchorStore.read()?.generation ?? 0) + 1;
    const record = await createRecord(input, generation);
    const raw = recordBytes(record);
    mkdirSync(this.options.dataDir, { recursive: true });
    writeFileAtomic(this.pendingPath, raw);
    this.options.anchorStore.write({ libraryId: record.libraryId, generation: record.generation, recordHash: recordHash(raw) });
    this.writeConfiguredMarker();
    renameSync(this.pendingPath, this.masterPath);
  }

  private reconcilePendingTransition(): void {
    if (!existsSync(this.pendingPath) || !this.options.anchorStore.isAvailable()) return;
    const pending = readFileSync(this.pendingPath);
    const anchor = this.options.anchorStore.read();
    if (anchor?.recordHash === recordHash(pending)) {
      const pendingRecord = parseRecord(pending);
      if (pendingRecord !== null && (pendingRecord.libraryId !== anchor.libraryId || pendingRecord.generation !== anchor.generation)) {
        return;
      }
      if (pendingRecord !== null) this.writeConfiguredMarker();
      renameSync(this.pendingPath, this.masterPath);
      if (pendingRecord === null) this.completeRemoval();
      return;
    }
    if (!existsSync(this.masterPath)) return;
    const current = readFileSync(this.masterPath);
    const currentRecord = parseRecord(current);
    const currentIsCommitted =
      currentRecord === null
        ? anchor === null
        : anchor?.libraryId === currentRecord.libraryId &&
          anchor.generation === currentRecord.generation &&
          anchor.recordHash === recordHash(current);
    if (currentIsCommitted) unlinkSync(this.pendingPath);
  }

  private clearAnchorOrThrow(): void {
    this.options.anchorStore.clear();
    if (this.options.anchorStore.read() !== null) throw new Error('OS credential store refused to clear the app-lock anchor');
  }

  private writeConfiguredMarker(): void {
    if (existsSync(this.configuredMarkerPath) && readFileSync(this.configuredMarkerPath).equals(CONFIGURED_MARKER)) return;
    writeFileAtomic(this.configuredMarkerPath, CONFIGURED_MARKER);
  }

  private completeRemoval(): void {
    if (existsSync(this.configuredMarkerPath)) unlinkSync(this.configuredMarkerPath);
    this.clearAnchorOrThrow();
  }
}
