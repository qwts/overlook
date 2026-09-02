import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { derivePasswordKey } from './recovery.js';
import { KEY_KINDS, KEY_REF_PATTERN, type KeyKind } from '../../shared/keyring/types.js';

// Exported keyring entries (#517, ADR-0032 §2) — a sibling of the ADR-0008
// recovery file. One 32-byte data key sealed under a password-derived key,
// carrying the non-secret facts an importer needs to find the registry row
// it belongs to. Fixed length, so callers size-check before reading, and the
// whole header is GCM AAD: a flipped kind byte or reference fails the tag.
//
//   OVIK | version u8 | kind u8 | key_ref (16) | key version u16be |
//   salt (16) | nonce (12) | sealed key (32) | tag (16)

const MAGIC = Buffer.from('OVIK', 'ascii');
const VERSION = 1;
const REF_LEN = 16;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + 1 + 1 + REF_LEN + 2 + SALT_LEN + NONCE_LEN;
const FILE_LEN = HEADER_LEN + KEY_LEN + TAG_LEN;

export const KEY_FILE_LENGTH = FILE_LEN;

const KIND_BYTES: Readonly<Record<KeyKind, number>> = { library: 1, item: 2, space: 3 };

export type KeyFileFailure = 'invalid' | 'wrong-password';

export class KeyFileError extends Error {
  override readonly name = 'KeyFileError';
  constructor(readonly reason: KeyFileFailure) {
    super(reason === 'invalid' ? 'not an Overlook key file' : 'wrong password (or a corrupted file)');
  }
}

export interface KeyFileFacts {
  readonly kind: KeyKind;
  readonly keyRef: string;
  readonly version: number;
}

function header(facts: KeyFileFacts, salt: Buffer, nonce: Buffer): Buffer {
  const fixed = Buffer.alloc(2 + REF_LEN + 2);
  fixed.writeUInt8(VERSION, 0);
  fixed.writeUInt8(KIND_BYTES[facts.kind], 1);
  Buffer.from(facts.keyRef, 'hex').copy(fixed, 2);
  fixed.writeUInt16BE(facts.version, 2 + REF_LEN);
  return Buffer.concat([MAGIC, fixed, salt, nonce]);
}

/** Seals one data key into the key-file byte layout. */
export function sealKeyFile(key: Buffer, facts: KeyFileFacts, password: string): Buffer {
  if (key.length !== KEY_LEN || !KEY_REF_PATTERN.test(facts.keyRef) || facts.version < 1 || facts.version > 0xffff) {
    throw new KeyFileError('invalid');
  }
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const aad = header(facts, salt, nonce);
  const cipher = createCipheriv('aes-256-gcm', derivePasswordKey(password, salt), nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
}

/** The plaintext facts of a key file — enough to find its registry row
 * before any password work. Authenticated only once the file is opened. */
export function readKeyFileFacts(data: Buffer): KeyFileFacts {
  if (data.length !== FILE_LEN || !data.subarray(0, MAGIC.length).equals(MAGIC) || data[MAGIC.length] !== VERSION) {
    throw new KeyFileError('invalid');
  }
  const kindByte = data[MAGIC.length + 1];
  const kind = KEY_KINDS.find((candidate) => KIND_BYTES[candidate] === kindByte);
  if (kind === undefined) throw new KeyFileError('invalid');
  const refStart = MAGIC.length + 2;
  const version = data.readUInt16BE(refStart + REF_LEN);
  if (version < 1) throw new KeyFileError('invalid');
  return { kind, keyRef: data.subarray(refStart, refStart + REF_LEN).toString('hex'), version };
}

/** Opens a key file; a wrong password and tampering are indistinguishable
 * by design — one GCM tag authenticates both. */
export function openKeyFile(data: Buffer, password: string): KeyFileFacts & { readonly key: Buffer } {
  const facts = readKeyFileFacts(data);
  const saltStart = HEADER_LEN - SALT_LEN - NONCE_LEN;
  const salt = data.subarray(saltStart, saltStart + SALT_LEN);
  const nonce = data.subarray(saltStart + SALT_LEN, HEADER_LEN);
  const decipher = createDecipheriv('aes-256-gcm', derivePasswordKey(password, salt), nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(data.subarray(0, HEADER_LEN));
  decipher.setAuthTag(data.subarray(FILE_LEN - TAG_LEN));
  try {
    return { ...facts, key: Buffer.concat([decipher.update(data.subarray(HEADER_LEN, FILE_LEN - TAG_LEN)), decipher.final()]) };
  } catch {
    throw new KeyFileError('wrong-password');
  }
}

/** The keyring fingerprint — HKDF-derived like the recovery fingerprint,
 * under its own label so the two identifier spaces never collide. */
export function keyFingerprintOf(key: Buffer): string {
  const bytes = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'overlook keyring fingerprint v1', 8));
  const hex = bytes.toString('hex').toUpperCase();
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)].join('·');
}
