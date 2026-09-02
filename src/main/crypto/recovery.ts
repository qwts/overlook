import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SafeStorageLike } from './keystore.js';
import { unwrapStoredKey, readKeysFile } from './keystore.js';

// Recovery-key backup/import (#240, ADR-0008): the 32-byte master key
// sealed under a password-derived key in a small versioned file. scrypt
// (N=2^17, r=8, p=1 — ~128 MiB, ~1s) makes offline guessing expensive;
// AES-256-GCM authenticates the whole file (header as AAD), so any byte
// flip or a wrong password fails the same tag check. Passwords cannot be
// reset by construction: nothing about them is stored anywhere.

const MAGIC = Buffer.from('OVRK', 'ascii');
const VERSION = 1;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
// scrypt cost: 128 * N * r bytes = 128 MiB; maxmem must clear it.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 160 * 1024 * 1024;

/** header = MAGIC ‖ version ‖ salt ‖ nonce; also the GCM AAD. */
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + NONCE_LEN;
const FILE_LEN = HEADER_LEN + KEY_LEN + TAG_LEN;

/** Callers size-check before reading (security review P2-1): a recovery
 * file is exactly this many bytes, so nothing larger is ever buffered. */
export const RECOVERY_FILE_LENGTH = FILE_LEN;

export type RecoveryFailure = 'invalid' | 'wrong-password';

export class RecoveryError extends Error {
  override readonly name = 'RecoveryError';
  constructor(readonly reason: RecoveryFailure) {
    super(reason === 'invalid' ? 'not a recovery-key file' : 'wrong password (or a corrupted file)');
  }
}

/** The password-derived sealing key; shared with exported keyring entries
 * (#517) so both file formats cost an attacker the same. */
export function derivePasswordKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

const deriveKey = derivePasswordKey;

/** Seals the master key into the `overlook-recovery.key` byte layout. */
export function sealRecoveryKey(masterKey: Buffer, password: string): Buffer {
  if (masterKey.length !== KEY_LEN) {
    throw new RecoveryError('invalid');
  }
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, nonce]);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

/** Opens a recovery file; distinguishes not-a-recovery-file from a failed
 * decrypt (wrong password and tampering are indistinguishable by design —
 * GCM authenticates both through one tag). */
export function openRecoveryKey(data: Buffer, password: string): Buffer {
  if (data.length !== FILE_LEN || !data.subarray(0, MAGIC.length).equals(MAGIC) || data[MAGIC.length] !== VERSION) {
    throw new RecoveryError('invalid');
  }
  const salt = data.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
  const nonce = data.subarray(MAGIC.length + 1 + SALT_LEN, HEADER_LEN);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(data.subarray(0, HEADER_LEN));
  decipher.setAuthTag(data.subarray(FILE_LEN - TAG_LEN));
  try {
    return Buffer.concat([decipher.update(data.subarray(HEADER_LEN, FILE_LEN - TAG_LEN)), decipher.final()]);
  } catch {
    throw new RecoveryError('wrong-password');
  }
}

/** The Settings/dialog fingerprint — an HKDF-derived identifier, never a
 * direct hash of the key material. "9F2C·4A81·D0E7·5B3A" per the mock. */
export function fingerprintOf(masterKey: Buffer): string {
  const bytes = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'overlook recovery fingerprint v1', 8));
  const hex = bytes.toString('hex').toUpperCase();
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)].join('·');
}

export type InstallResult = 'installed' | 'already-installed' | 'mismatch' | 'no-library';

/** Installs a recovered master key into a library dir (#240). Works without
 * an open KeyStore — the restore scenario is exactly the one where the
 * store cannot open. Validation is honest: if keys.json exists, the key
 * must unwrap its rows (a restored library); a matching installed master is
 * a no-op; anything else is a refusal, never an overwrite of a working key. */
export function installRecoveredMaster(dataDir: string, safeStorage: SafeStorageLike, masterKey: Buffer): InstallResult {
  // An empty keys file vouches for nothing — treat it like no file at all.
  const parsed = readKeysFile(dataDir);
  const keysFile = parsed !== null && parsed.keys.length > 0 ? parsed : null;
  const masterPath = join(dataDir, 'master.key');
  // Nothing here at all — no keys to vouch, no master to compare. Installing
  // into a void would wedge the NEXT bootstrap ("master exists but no
  // library keys"); restore the library files first (security review P2-2).
  if (keysFile === null && !existsSync(masterPath)) {
    return 'no-library';
  }
  if (keysFile !== null) {
    for (const record of keysFile.keys) {
      try {
        unwrapStoredKey(masterKey, record.id, record.wrappedKey);
      } catch {
        return 'mismatch';
      }
    }
  }
  if (existsSync(masterPath)) {
    try {
      const current = Buffer.from(safeStorage.decryptString(readFileSync(masterPath)), 'base64');
      if (current.length === masterKey.length && timingSafeEqual(current, masterKey)) {
        return 'already-installed';
      }
    } catch {
      // Unreadable current master (foreign keychain after a restore): the
      // validated key replaces it below.
    }
    // A DIFFERENT working master with no keys.json to arbitrate would mean
    // overwriting a live library's custody — only proceed when the keys
    // file vouched for the imported key.
    if (keysFile === null) {
      return 'mismatch';
    }
  }
  mkdirSync(dataDir, { recursive: true });
  const temp = `${masterPath}.tmp`;
  writeFileSync(temp, safeStorage.encryptString(masterKey.toString('base64')));
  renameSync(temp, masterPath);
  return 'installed';
}
