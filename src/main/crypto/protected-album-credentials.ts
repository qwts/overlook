import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { openRecoveryKey } from './recovery.js';
import { assertStrongPassword, createPasswordSaltV1, derivePasswordKeyV1, PASSWORD_KDF_V1 } from './password-kdf.js';

const CREDENTIAL_MAGIC = Buffer.from('OVPA', 'ascii');
const METADATA_MAGIC = Buffer.from('OVPM', 'ascii');
const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ID_BYTES = 256;
const MAX_CREDENTIAL_RECORD_BYTES = 64 * 1024;
const MAX_SEALED_METADATA_BYTES = 64 * 1024 * 1024;

const canonicalBase64 = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}, 'must be canonical base64');

const idSchema = z.string().min(1).max(MAX_ID_BYTES);

const keySlotSchema = z
  .object({
    algorithm: z.literal('AES-256-GCM'),
    nonce: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === NONCE_BYTES),
    ciphertextAndTag: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === KEY_BYTES + TAG_BYTES),
  })
  .strict();

const credentialRecordSchema = z
  .object({
    version: z.literal(VERSION),
    libraryId: idSchema,
    albumId: idSchema,
    passwordGeneration: z.number().int().positive(),
    recoveryGeneration: z.number().int().positive(),
    metadataGeneration: z.number().int().positive(),
    kdf: z
      .object({
        name: z.literal(PASSWORD_KDF_V1.name),
        N: z.literal(PASSWORD_KDF_V1.N),
        r: z.literal(PASSWORD_KDF_V1.r),
        p: z.literal(PASSWORD_KDF_V1.p),
        salt: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === PASSWORD_KDF_V1.saltBytes),
      })
      .strict(),
    passwordSlot: keySlotSchema,
    recoverySlot: keySlotSchema,
  })
  .strict();

const sealedMetadataSchema = z
  .object({
    version: z.literal(VERSION),
    generation: z.number().int().positive(),
    algorithm: z.literal('AES-256-GCM'),
    nonce: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === NONCE_BYTES),
    ciphertextAndTag: canonicalBase64.refine((value) => {
      const bytes = Buffer.from(value, 'base64').length;
      return bytes >= TAG_BYTES && bytes <= MAX_SEALED_METADATA_BYTES;
    }),
  })
  .strict();

const membershipSchema = z
  .object({
    albumId: idSchema,
    position: z.number().int().nonnegative(),
  })
  .strict();

const ordinaryAlbumSchema = z
  .object({
    id: idSchema,
    createdAt: z.iso.datetime({ offset: true }),
    position: z.number().int().nonnegative(),
  })
  .strict();

const protectedMemberSchema = z
  .object({
    photoId: idSchema,
    position: z.number().int().nonnegative(),
    ordinaryMemberships: z.array(membershipSchema).readonly(),
  })
  .strict()
  .superRefine((member, context) => {
    const ids = new Set<string>();
    for (const [index, membership] of member.ordinaryMemberships.entries()) {
      if (ids.has(membership.albumId))
        context.addIssue({ code: 'custom', path: ['ordinaryMemberships', index], message: 'duplicate album' });
      ids.add(membership.albumId);
    }
  });

export const protectedAlbumMetadataSchema = z
  .object({
    version: z.literal(VERSION),
    name: z.string().min(1).max(120),
    createdAt: z.iso.datetime({ offset: true }),
    position: z.number().int().nonnegative(),
    ordinaryAlbum: ordinaryAlbumSchema.optional(),
    members: z.array(protectedMemberSchema).readonly(),
  })
  .strict()
  .superRefine((metadata, context) => {
    const ids = new Set<string>();
    const positions = new Set<number>();
    for (const [index, member] of metadata.members.entries()) {
      if (ids.has(member.photoId)) context.addIssue({ code: 'custom', path: ['members', index], message: 'duplicate photo' });
      if (positions.has(member.position)) context.addIssue({ code: 'custom', path: ['members', index], message: 'duplicate position' });
      ids.add(member.photoId);
      positions.add(member.position);
    }
  });

type KeySlot = z.output<typeof keySlotSchema>;
export type ProtectedAlbumMetadata = z.output<typeof protectedAlbumMetadataSchema>;
export type ProtectedAlbumCredentialRecord = z.output<typeof credentialRecordSchema>;

export type ProtectedAlbumCredentialFailure = 'invalid-record' | 'wrong-password' | 'wrong-recovery-key';

export class ProtectedAlbumCredentialError extends Error {
  override readonly name = 'ProtectedAlbumCredentialError';
  constructor(readonly reason: ProtectedAlbumCredentialFailure) {
    super(reason);
  }
}

export interface ProtectedAlbumCustody {
  readonly credentialRecord: Buffer;
  readonly sealedMetadata: Buffer;
  /** Caller-owned and must be zeroized after transferring it to session custody. */
  readonly albumKey: Buffer;
}

export interface ProtectedAlbumContext {
  readonly libraryId: string;
  readonly albumId: string;
}

function validateContext(context: ProtectedAlbumContext): void {
  idSchema.parse(context.libraryId);
  idSchema.parse(context.albumId);
}

function validateKey(key: Buffer, label: string): void {
  if (key.length !== KEY_BYTES) throw new Error(`${label} must be 32 bytes`);
}

function aad(context: ProtectedAlbumContext, purpose: 'password' | 'recovery' | 'metadata', generation: number): Buffer {
  return Buffer.from(JSON.stringify(['OVPA', VERSION, context.libraryId, context.albumId, purpose, generation, 'AES-256-GCM']), 'utf8');
}

function seal(key: Buffer, plaintext: Buffer, associatedData: Buffer): KeySlot {
  validateKey(key, 'sealing key');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData);
  const ciphertextAndTag = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: 'AES-256-GCM', nonce: nonce.toString('base64'), ciphertextAndTag: ciphertextAndTag.toString('base64') };
}

function open(key: Buffer, slot: KeySlot, associatedData: Buffer): Buffer {
  validateKey(key, 'opening key');
  const nonce = Buffer.from(slot.nonce, 'base64');
  const sealed = Buffer.from(slot.ciphertextAndTag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(sealed.subarray(-TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(0, -TAG_BYTES)), decipher.final()]);
}

function encode(magic: Buffer, value: object): Buffer {
  return Buffer.concat([magic, Buffer.from(JSON.stringify(value), 'utf8')]);
}

function parseCredentialRecord(raw: Buffer, expected: ProtectedAlbumContext): ProtectedAlbumCredentialRecord {
  validateContext(expected);
  if (raw.length <= CREDENTIAL_MAGIC.length || raw.length > MAX_CREDENTIAL_RECORD_BYTES || !raw.subarray(0, 4).equals(CREDENTIAL_MAGIC)) {
    throw new ProtectedAlbumCredentialError('invalid-record');
  }
  try {
    const json = raw.subarray(CREDENTIAL_MAGIC.length).toString('utf8');
    const record = credentialRecordSchema.parse(JSON.parse(json) as unknown);
    if (JSON.stringify(record) !== json || record.libraryId !== expected.libraryId || record.albumId !== expected.albumId) {
      throw new ProtectedAlbumCredentialError('invalid-record');
    }
    return record;
  } catch (error) {
    if (error instanceof ProtectedAlbumCredentialError) throw error;
    throw new ProtectedAlbumCredentialError('invalid-record');
  }
}

function parseSealedMetadata(raw: Buffer, generation: number): z.output<typeof sealedMetadataSchema> {
  if (raw.length <= METADATA_MAGIC.length || raw.length > MAX_SEALED_METADATA_BYTES * 2 || !raw.subarray(0, 4).equals(METADATA_MAGIC)) {
    throw new ProtectedAlbumCredentialError('invalid-record');
  }
  try {
    const json = raw.subarray(METADATA_MAGIC.length).toString('utf8');
    const sealed = sealedMetadataSchema.parse(JSON.parse(json) as unknown);
    if (JSON.stringify(sealed) !== json || sealed.generation !== generation) throw new ProtectedAlbumCredentialError('invalid-record');
    return sealed;
  } catch (error) {
    if (error instanceof ProtectedAlbumCredentialError) throw error;
    throw new ProtectedAlbumCredentialError('invalid-record');
  }
}

function sealMetadata(context: ProtectedAlbumContext, albumKey: Buffer, generation: number, input: ProtectedAlbumMetadata): Buffer {
  const metadata = protectedAlbumMetadataSchema.parse(input);
  const plaintext = Buffer.from(JSON.stringify(metadata), 'utf8');
  try {
    // AES-GCM preserves plaintext length and appends one authentication tag.
    // Refuse input that would create a record our decoder cannot accept.
    if (plaintext.length + TAG_BYTES > MAX_SEALED_METADATA_BYTES) {
      throw new ProtectedAlbumCredentialError('invalid-record');
    }
    const slot = seal(albumKey, plaintext, aad(context, 'metadata', generation));
    return encode(METADATA_MAGIC, { version: VERSION, generation, ...slot });
  } finally {
    plaintext.fill(0);
  }
}

export function openProtectedAlbumMetadata(
  context: ProtectedAlbumContext,
  albumKey: Buffer,
  credentialRecord: Buffer,
  sealedMetadata: Buffer,
): ProtectedAlbumMetadata {
  const record = parseCredentialRecord(credentialRecord, context);
  const sealed = parseSealedMetadata(sealedMetadata, record.metadataGeneration);
  let plaintext: Buffer | undefined;
  try {
    plaintext = open(albumKey, sealed, aad(context, 'metadata', sealed.generation));
    const json = plaintext.toString('utf8');
    const metadata = protectedAlbumMetadataSchema.parse(JSON.parse(json) as unknown);
    if (JSON.stringify(metadata) !== json) throw new ProtectedAlbumCredentialError('invalid-record');
    return metadata;
  } catch (error) {
    if (error instanceof ProtectedAlbumCredentialError) throw error;
    throw new ProtectedAlbumCredentialError('invalid-record');
  } finally {
    plaintext?.fill(0);
  }
}

function recordWithPasswordSlot(
  context: ProtectedAlbumContext,
  record: ProtectedAlbumCredentialRecord,
  generation: number,
  salt: Buffer,
  passwordKey: Buffer,
  albumKey: Buffer,
): ProtectedAlbumCredentialRecord {
  return {
    ...record,
    passwordGeneration: generation,
    kdf: {
      name: PASSWORD_KDF_V1.name,
      N: PASSWORD_KDF_V1.N,
      r: PASSWORD_KDF_V1.r,
      p: PASSWORD_KDF_V1.p,
      salt: salt.toString('base64'),
    },
    passwordSlot: seal(passwordKey, albumKey, aad(context, 'password', generation)),
  };
}

export async function createProtectedAlbumCustody(
  input: ProtectedAlbumContext & { readonly password: string; readonly masterKey: Buffer; readonly metadata: ProtectedAlbumMetadata },
): Promise<ProtectedAlbumCustody> {
  validateContext(input);
  validateKey(input.masterKey, 'master key');
  assertStrongPassword(input.password);
  const albumKey = randomBytes(KEY_BYTES);
  const salt = createPasswordSaltV1();
  const passwordKey = await derivePasswordKeyV1(input.password, salt);
  const context = { libraryId: input.libraryId, albumId: input.albumId };
  try {
    const passwordGeneration = 1;
    const recoveryGeneration = 1;
    const metadataGeneration = 1;
    const base: ProtectedAlbumCredentialRecord = {
      version: VERSION,
      ...context,
      passwordGeneration,
      recoveryGeneration,
      metadataGeneration,
      kdf: {
        name: PASSWORD_KDF_V1.name,
        N: PASSWORD_KDF_V1.N,
        r: PASSWORD_KDF_V1.r,
        p: PASSWORD_KDF_V1.p,
        salt: salt.toString('base64'),
      },
      passwordSlot: seal(passwordKey, albumKey, aad(context, 'password', passwordGeneration)),
      recoverySlot: seal(input.masterKey, albumKey, aad(context, 'recovery', recoveryGeneration)),
    };
    return {
      credentialRecord: encode(CREDENTIAL_MAGIC, base),
      sealedMetadata: sealMetadata(context, albumKey, metadataGeneration, input.metadata),
      albumKey,
    };
  } catch (error) {
    albumKey.fill(0);
    throw error;
  } finally {
    passwordKey.fill(0);
  }
}

export async function unlockProtectedAlbumCustody(
  context: ProtectedAlbumContext,
  credentialRecord: Buffer,
  sealedMetadata: Buffer,
  password: string,
): Promise<{ readonly albumKey: Buffer; readonly metadata: ProtectedAlbumMetadata }> {
  if (password.length < 1 || password.length > 1024) throw new ProtectedAlbumCredentialError('wrong-password');
  const record = parseCredentialRecord(credentialRecord, context);
  const passwordKey = await derivePasswordKeyV1(password, Buffer.from(record.kdf.salt, 'base64'));
  let albumKey: Buffer | undefined;
  try {
    albumKey = open(passwordKey, record.passwordSlot, aad(context, 'password', record.passwordGeneration));
    validateKey(albumKey, 'album key');
    const metadata = openProtectedAlbumMetadata(context, albumKey, credentialRecord, sealedMetadata);
    return { albumKey, metadata };
  } catch (error) {
    albumKey?.fill(0);
    if (error instanceof ProtectedAlbumCredentialError && error.reason === 'invalid-record') throw error;
    throw new ProtectedAlbumCredentialError('wrong-password');
  } finally {
    passwordKey.fill(0);
  }
}

export async function changeProtectedAlbumPassword(
  context: ProtectedAlbumContext,
  credentialRecord: Buffer,
  sealedMetadata: Buffer,
  currentPassword: string,
  nextPassword: string,
): Promise<{ readonly credentialRecord: Buffer; readonly albumKey: Buffer; readonly metadata: ProtectedAlbumMetadata }> {
  assertStrongPassword(nextPassword);
  const unlocked = await unlockProtectedAlbumCustody(context, credentialRecord, sealedMetadata, currentPassword);
  const record = parseCredentialRecord(credentialRecord, context);
  const salt = createPasswordSaltV1();
  let passwordKey: Buffer | undefined;
  try {
    passwordKey = await derivePasswordKeyV1(nextPassword, salt);
    const next = recordWithPasswordSlot(context, record, record.passwordGeneration + 1, salt, passwordKey, unlocked.albumKey);
    return { credentialRecord: encode(CREDENTIAL_MAGIC, next), albumKey: unlocked.albumKey, metadata: unlocked.metadata };
  } catch (error) {
    unlocked.albumKey.fill(0);
    throw error;
  } finally {
    passwordKey?.fill(0);
  }
}

export async function recoverProtectedAlbumPassword(
  context: ProtectedAlbumContext,
  credentialRecord: Buffer,
  sealedMetadata: Buffer,
  recoveryFile: Buffer,
  recoveryPassword: string,
  nextPassword: string,
): Promise<{ readonly credentialRecord: Buffer; readonly albumKey: Buffer; readonly metadata: ProtectedAlbumMetadata }> {
  assertStrongPassword(nextPassword);
  const record = parseCredentialRecord(credentialRecord, context);
  let masterKey: Buffer | undefined;
  let albumKey: Buffer | undefined;
  try {
    masterKey = openRecoveryKey(recoveryFile, recoveryPassword);
    albumKey = open(masterKey, record.recoverySlot, aad(context, 'recovery', record.recoveryGeneration));
    validateKey(albumKey, 'album key');
    const metadata = openProtectedAlbumMetadata(context, albumKey, credentialRecord, sealedMetadata);
    const salt = createPasswordSaltV1();
    const passwordKey = await derivePasswordKeyV1(nextPassword, salt);
    try {
      const next = recordWithPasswordSlot(context, record, record.passwordGeneration + 1, salt, passwordKey, albumKey);
      return { credentialRecord: encode(CREDENTIAL_MAGIC, next), albumKey, metadata };
    } finally {
      passwordKey.fill(0);
    }
  } catch (error) {
    albumKey?.fill(0);
    if (error instanceof ProtectedAlbumCredentialError && error.reason === 'invalid-record') throw error;
    throw new ProtectedAlbumCredentialError('wrong-recovery-key');
  } finally {
    masterKey?.fill(0);
  }
}

export function inspectProtectedAlbumCredentialRecord(
  context: ProtectedAlbumContext,
  raw: Buffer,
): Pick<ProtectedAlbumCredentialRecord, 'passwordGeneration' | 'metadataGeneration'> {
  const record = parseCredentialRecord(raw, context);
  return { passwordGeneration: record.passwordGeneration, metadataGeneration: record.metadataGeneration };
}
