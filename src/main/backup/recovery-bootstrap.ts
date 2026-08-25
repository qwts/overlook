import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { unwrapStoredKey, type KeyStore, type WrappedKeyRecord } from '../crypto/keystore.js';
import type { KeyResolver } from '../crypto/envelope.js';

const MAGIC = Buffer.from('OVRB', 'ascii');
const FORMAT_VERSION_V1 = 1;
const FORMAT_VERSION_V2 = 2;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + NONCE_LENGTH;
const KEY_LENGTH = 32;
const MAX_BOOTSTRAP_LENGTH = 1024 * 1024;
const DERIVATION_INFO = {
  [FORMAT_VERSION_V1]: Buffer.from('overlook cloud recovery bootstrap v1', 'utf8'),
  [FORMAT_VERSION_V2]: Buffer.from('overlook cloud recovery bootstrap v2', 'utf8'),
} as const;

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'expected a Crockford ULID');
const isoTimestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest');
const wrappedKeySchema = z
  .string()
  .min(1)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === NONCE_LENGTH + TAG_LENGTH + KEY_LENGTH && decoded.toString('base64') === value;
  }, 'invalid wrapped-key encoding');
const nonceHighWaterSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .refine((value) => BigInt(value) <= 1n << 64n, 'nonce high-water mark exceeds the 64-bit prefix space');

const wrappedKeysSchema = z
  .array(
    z.strictObject({
      id: z.number().int().positive(),
      createdAt: isoTimestampSchema,
      status: z.enum(['active', 'retired']),
      wrappedKey: wrappedKeySchema,
      nonceHighWater: nonceHighWaterSchema.optional(),
    }),
  )
  .min(1)
  .readonly();

export const recoveryBootstrapSchema = z
  .discriminatedUnion('schema', [
    z.strictObject({
      schema: z.literal(1),
      libraryId: ulidSchema,
      generatedAt: isoTimestampSchema,
      keys: wrappedKeysSchema,
    }),
    z.strictObject({
      schema: z.literal(2),
      libraryId: ulidSchema,
      generatedAt: isoTimestampSchema,
      manifestGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      manifestSha256: sha256Schema,
      previousManifest: z
        .strictObject({
          generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          sha256: sha256Schema,
        })
        .nullable(),
      keys: wrappedKeysSchema,
    }),
  ])
  .superRefine((bootstrap, context) => {
    const ids = new Set<number>();
    let active = 0;
    for (const [index, key] of bootstrap.keys.entries()) {
      if (ids.has(key.id)) {
        context.addIssue({ code: 'custom', path: ['keys', index, 'id'], message: 'key IDs must be unique' });
      }
      ids.add(key.id);
      if (key.status === 'active') {
        active += 1;
      }
    }
    if (active !== 1) {
      context.addIssue({ code: 'custom', path: ['keys'], message: 'exactly one key must be active' });
    }
    if (bootstrap.schema === 2) {
      const expectedPrevious = bootstrap.manifestGeneration - 1;
      if (expectedPrevious === 0 && bootstrap.previousManifest !== null) {
        context.addIssue({ code: 'custom', path: ['previousManifest'], message: 'generation 1 cannot bind a previous manifest' });
      } else if (expectedPrevious > 0 && bootstrap.previousManifest?.generation !== expectedPrevious) {
        context.addIssue({
          code: 'custom',
          path: ['previousManifest', 'generation'],
          message: 'previous manifest must immediately precede the current generation',
        });
      }
    }
  });

export interface RecoveryBootstrapV1 {
  readonly schema: 1;
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly keys: readonly WrappedKeyRecord[];
}

export interface RecoveryBootstrapV2 {
  readonly schema: 2;
  readonly libraryId: string;
  readonly generatedAt: string;
  readonly manifestGeneration: number;
  readonly manifestSha256: string;
  readonly previousManifest: RecoveryManifestBinding | null;
  readonly keys: readonly WrappedKeyRecord[];
}

export type RecoveryBootstrap = RecoveryBootstrapV1 | RecoveryBootstrapV2;

export interface RecoveryManifestBinding {
  readonly generation: number;
  readonly sha256: string;
}

export interface RecoveryBootstrapPublication {
  readonly generatedAt: string;
  readonly manifestGeneration: number;
  readonly manifestSha256: string;
  readonly previousManifest: RecoveryManifestBinding | null;
}

export class RecoveryBootstrapError extends Error {
  override readonly name = 'RecoveryBootstrapError';
}

function assertMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_LENGTH) {
    throw new RecoveryBootstrapError(`master key must be ${String(KEY_LENGTH)} bytes`);
  }
}

function deriveBootstrapKey(masterKey: Buffer, version: 1 | 2): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), DERIVATION_INFO[version], KEY_LENGTH));
}

/** Encrypts the recovery bootstrap under a domain-separated key derived
 * from the recovery master. Wrapped library keys remain wrapped inside it. */
export function sealRecoveryBootstrap(input: RecoveryBootstrap, masterKey: Buffer): Buffer {
  assertMasterKey(masterKey);
  const bootstrap = recoveryBootstrapSchema.parse(input);
  const version = bootstrap.schema;
  const nonce = randomBytes(NONCE_LENGTH);
  const header = Buffer.concat([MAGIC, Buffer.from([version]), nonce]);
  const cipher = createCipheriv('aes-256-gcm', deriveBootstrapKey(masterKey, version), nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bootstrap), 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
  if (sealed.length > MAX_BOOTSTRAP_LENGTH) {
    throw new RecoveryBootstrapError('recovery bootstrap exceeds the size limit');
  }
  return sealed;
}

/** Composition-root helper that limits the lifetime of the copied master
 * key and guarantees it is wiped after the bootstrap is sealed. */
export function sealKeyStoreRecoveryBootstrap(
  input: {
    readonly keyStore: Pick<KeyStore, 'exportWrappedKeys' | 'masterKeyBytes'>;
    readonly libraryId: string;
  } & RecoveryBootstrapPublication,
): Buffer {
  const masterKey = input.keyStore.masterKeyBytes();
  try {
    return sealRecoveryBootstrap(
      {
        schema: 2,
        libraryId: input.libraryId,
        generatedAt: input.generatedAt,
        manifestGeneration: input.manifestGeneration,
        manifestSha256: input.manifestSha256,
        previousManifest: input.previousManifest,
        keys: input.keyStore.exportWrappedKeys(),
      },
      masterKey,
    );
  } finally {
    masterKey.fill(0);
  }
}

/** Binds composition-root dependencies without copying the recovered master
 * key until a publication is actually sealed. */
export function createRecoveryBootstrapSealer(
  keyStore: Pick<KeyStore, 'exportWrappedKeys' | 'masterKeyBytes'>,
  libraryId: () => string,
): (publication: RecoveryBootstrapPublication) => Buffer {
  return (publication) => sealKeyStoreRecoveryBootstrap({ keyStore, libraryId: libraryId(), ...publication });
}

/** Opens and validates a bootstrap using only the recovered master key. */
export function openRecoveryBootstrap(sealed: Buffer, masterKey: Buffer): RecoveryBootstrap {
  assertMasterKey(masterKey);
  if (sealed.length < HEADER_LENGTH + TAG_LENGTH || sealed.length > MAX_BOOTSTRAP_LENGTH) {
    throw new RecoveryBootstrapError('invalid recovery-bootstrap length');
  }
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new RecoveryBootstrapError('not an Overlook recovery bootstrap');
  }
  const version = sealed.readUInt8(MAGIC.length);
  if (version !== FORMAT_VERSION_V1 && version !== FORMAT_VERSION_V2) {
    throw new RecoveryBootstrapError(`unsupported recovery-bootstrap version ${String(version)}`);
  }
  const header = sealed.subarray(0, HEADER_LENGTH);
  const nonce = sealed.subarray(MAGIC.length + 1, HEADER_LENGTH);
  const ciphertext = sealed.subarray(HEADER_LENGTH, sealed.length - TAG_LENGTH);
  const tag = sealed.subarray(sealed.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', deriveBootstrapKey(masterKey, version), nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new RecoveryBootstrapError('recovery bootstrap failed authentication');
  }
  let input: unknown;
  try {
    input = JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new RecoveryBootstrapError('recovery bootstrap is not valid JSON');
  }
  const parsed = recoveryBootstrapSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecoveryBootstrapError(`invalid recovery bootstrap: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.schema !== version) {
    throw new RecoveryBootstrapError('recovery-bootstrap framing and schema versions do not match');
  }
  return parsed.data;
}

/** Builds the envelope-key resolver needed to decrypt manifests and blobs
 * on a machine that has no local keys.json. */
export function recoveryBootstrapResolver(bootstrap: RecoveryBootstrap, masterKey: Buffer): KeyResolver {
  assertMasterKey(masterKey);
  const parsed = recoveryBootstrapSchema.parse(bootstrap);
  const keys = new Map<number, Buffer>();
  for (const record of parsed.keys) {
    try {
      keys.set(record.id, unwrapStoredKey(masterKey, record.id, record.wrappedKey));
    } catch (error) {
      throw new RecoveryBootstrapError(
        `wrapped key ${String(record.id)} failed recovery validation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return (keyId) => keys.get(keyId);
}
