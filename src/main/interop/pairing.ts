import { createCipheriv, createDecipheriv, pbkdf2 as pbkdf2Callback, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import {
  INTEROP_PAIRING_FORMAT_VERSION,
  INTEROP_PAIRING_MAGIC,
  INTEROP_PAIRING_PBKDF2_ITERATIONS,
  interopPairingBundleSchema,
  interopPairingPayloadSchema,
  type InteropPairingBundle,
} from '../../shared/interop/pairing-contract.js';

const derivePbkdf2 = promisify(pbkdf2Callback);
const PAIRING_AAD_CONTEXT = 'overlook-image-trail/pairing/v1';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

export class InteropPairingError extends Error {
  override readonly name = 'InteropPairingError';
}

export interface CreateInteropPairingOptions {
  readonly now?: string;
  readonly pairingId?: string;
  readonly keyId?: string;
  readonly salt?: Buffer;
  readonly iv?: Buffer;
  readonly interopKey?: Buffer;
}

export interface OpenedInteropPairing {
  readonly pairingId: string;
  readonly keyId: string;
  readonly interopKey: Buffer;
  readonly createdAt: string;
}

function assertPassword(password: string): void {
  if (password.length === 0) throw new InteropPairingError('Pairing password is required.');
}

function assertLength(value: Buffer, length: number, name: string): void {
  if (value.length !== length) throw new InteropPairingError(`${name} must be ${String(length)} bytes.`);
}

function decodeCanonicalBase64(value: string, length: number, name: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || decoded.length !== length) {
    throw new InteropPairingError(`Invalid ${name}.`);
  }
  return decoded;
}

async function derivePairingKey(password: string, salt: Buffer): Promise<Buffer> {
  const normalized = Buffer.from(password.normalize('NFKC'), 'utf8');
  try {
    return await derivePbkdf2(normalized, salt, INTEROP_PAIRING_PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
  } finally {
    normalized.fill(0);
  }
}

function pairingAad(
  bundle: Omit<InteropPairingBundle, 'cipher'> & { readonly cipher: Omit<InteropPairingBundle['cipher'], 'ciphertext'> },
): Buffer {
  return Buffer.from(
    JSON.stringify({
      context: PAIRING_AAD_CONTEXT,
      magic: bundle.magic,
      formatVersion: bundle.formatVersion,
      pairingId: bundle.pairingId,
      keyId: bundle.keyId,
      createdAt: bundle.createdAt,
      kdf: bundle.kdf,
      cipher: bundle.cipher,
    }),
    'utf8',
  );
}

export async function createInteropPairingBundle(
  password: string,
  options: CreateInteropPairingOptions = {},
): Promise<InteropPairingBundle> {
  assertPassword(password);
  const pairingId = options.pairingId ?? randomUUID();
  const keyId = options.keyId ?? `interop:${randomUUID()}`;
  const createdAt = options.now ?? new Date().toISOString();
  const salt = Buffer.from(options.salt ?? randomBytes(SALT_BYTES));
  const iv = Buffer.from(options.iv ?? randomBytes(IV_BYTES));
  const interopKey = Buffer.from(options.interopKey ?? randomBytes(KEY_BYTES));
  let pairingKey: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    assertLength(salt, SALT_BYTES, 'Pairing salt');
    assertLength(iv, IV_BYTES, 'Pairing IV');
    assertLength(interopKey, KEY_BYTES, 'Interoperability key');
    const header = {
      magic: INTEROP_PAIRING_MAGIC,
      formatVersion: INTEROP_PAIRING_FORMAT_VERSION,
      pairingId,
      keyId,
      createdAt,
      kdf: {
        name: 'PBKDF2' as const,
        hash: 'SHA-256' as const,
        iterations: INTEROP_PAIRING_PBKDF2_ITERATIONS,
        salt: salt.toString('base64'),
      },
      cipher: {
        name: 'AES-256-GCM' as const,
        iv: iv.toString('base64'),
      },
    } as const;
    const payload = interopPairingPayloadSchema.parse({
      schemaVersion: 1,
      pairingId,
      keyId,
      interopKey: interopKey.toString('base64'),
      products: ['image-trail', 'overlook'],
      createdAt,
    });
    plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    pairingKey = await derivePairingKey(password, salt);
    const cipher = createCipheriv('aes-256-gcm', pairingKey, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(pairingAad(header));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return interopPairingBundleSchema.parse({
      ...header,
      cipher: { ...header.cipher, ciphertext: ciphertext.toString('base64') },
    });
  } finally {
    pairingKey?.fill(0);
    plaintext?.fill(0);
    interopKey.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

export async function openInteropPairingBundle(bundleValue: unknown, password: string): Promise<OpenedInteropPairing> {
  assertPassword(password);
  if (
    typeof bundleValue === 'object' &&
    bundleValue !== null &&
    'formatVersion' in bundleValue &&
    bundleValue.formatVersion !== INTEROP_PAIRING_FORMAT_VERSION
  ) {
    throw new InteropPairingError('Unsupported pairing bundle version.');
  }
  const parsed = interopPairingBundleSchema.safeParse(bundleValue);
  if (!parsed.success) throw new InteropPairingError('Invalid pairing bundle.');
  const bundle = parsed.data;
  const salt = decodeCanonicalBase64(bundle.kdf.salt, SALT_BYTES, 'pairing salt');
  const iv = decodeCanonicalBase64(bundle.cipher.iv, IV_BYTES, 'pairing IV');
  const sealed = Buffer.from(bundle.cipher.ciphertext, 'base64');
  let pairingKey: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    if (sealed.length <= AUTH_TAG_BYTES || sealed.toString('base64') !== bundle.cipher.ciphertext) {
      throw new InteropPairingError('Invalid pairing ciphertext.');
    }
    const ciphertext = sealed.subarray(0, sealed.length - AUTH_TAG_BYTES);
    const authTag = sealed.subarray(sealed.length - AUTH_TAG_BYTES);
    pairingKey = await derivePairingKey(password, salt);
    const decipher = createDecipheriv('aes-256-gcm', pairingKey, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(pairingAad({ ...bundle, cipher: { name: bundle.cipher.name, iv: bundle.cipher.iv } }));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payloadValue: unknown = JSON.parse(plaintext.toString('utf8'));
    const payload = interopPairingPayloadSchema.parse(payloadValue);
    if (payload.pairingId !== bundle.pairingId || payload.keyId !== bundle.keyId || payload.createdAt !== bundle.createdAt) {
      throw new InteropPairingError('Pairing payload did not match its authenticated header.');
    }
    return {
      pairingId: payload.pairingId,
      keyId: payload.keyId,
      interopKey: decodeCanonicalBase64(payload.interopKey, KEY_BYTES, 'interoperability key'),
      createdAt: payload.createdAt,
    };
  } catch (error) {
    if (error instanceof InteropPairingError) throw error;
    throw new InteropPairingError('Unable to open pairing bundle.');
  } finally {
    pairingKey?.fill(0);
    plaintext?.fill(0);
    sealed.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}
