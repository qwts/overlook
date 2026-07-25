import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { interopEnvelopeSchema, type InteropEnvelope } from '../../shared/interop/messages.js';
import type { InteropBlobReference } from '../../shared/interop/records.js';
import {
  INTEROP_MESSAGE_AAD_CONTEXT,
  INTEROP_SEALED_BLOB_MAGIC,
  INTEROP_SEALED_HEADER_MAX_BYTES,
  INTEROP_SEALED_MESSAGE_MAGIC,
  INTEROP_SEALED_TRANSPORT_VERSION,
  interopSealedBlobDescriptorSchema,
  interopSealedBlobHeaderSchema,
  interopSealedMessageSchema,
  type InteropSealedBlobDescriptor,
  type InteropSealedBlobHeader,
  type InteropSealedMessage,
} from '../../shared/interop/sealed-transport-contract.js';

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;
const decoder = new TextDecoder('utf-8', { fatal: true });

export type SealedInteropFailure = 'wrong-key' | 'corrupt' | 'unsupported-version';

export class SealedInteropError extends Error {
  override readonly name = 'SealedInteropError';

  constructor(
    message: string,
    readonly code: SealedInteropFailure,
  ) {
    super(message);
  }
}

export interface InteropKeyCustody {
  readonly pairingId: string;
  readonly keyId: string;
  readonly interopKey: Buffer;
}

export interface SealInteropOptions {
  readonly iv?: Buffer | undefined;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertKey(key: InteropKeyCustody): void {
  if (key.interopKey.length !== AES_KEY_BYTES) throw new SealedInteropError('Interoperability key is invalid.', 'wrong-key');
}

function ownedIv(value: Buffer | undefined): Buffer {
  const iv = Buffer.from(value ?? randomBytes(AES_IV_BYTES));
  if (iv.length !== AES_IV_BYTES) {
    iv.fill(0);
    throw new SealedInteropError('AES-GCM IV is invalid.', 'corrupt');
  }
  return iv;
}

function parseJson(bytes: Uint8Array, subject: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new SealedInteropError(`${subject} is invalid.`, 'corrupt');
  }
}

function rejectUnsupportedVersion(value: unknown, magic: string, subject: string): void {
  if (typeof value !== 'object' || value === null) return;
  if ('magic' in value && value.magic === magic && 'schemaVersion' in value && value.schemaVersion !== 1) {
    throw new SealedInteropError(`${subject} version is unsupported.`, 'unsupported-version');
  }
}

function messageAad(
  value: Omit<InteropSealedMessage, 'cipher'> & { readonly cipher: { readonly name: 'AES-GCM'; readonly iv: string } },
): Buffer {
  return Buffer.from(
    JSON.stringify({
      context: INTEROP_MESSAGE_AAD_CONTEXT,
      magic: value.magic,
      schemaVersion: value.schemaVersion,
      pairingId: value.pairingId,
      transferId: value.transferId,
      messageId: value.messageId,
      keyId: value.keyId,
      cipher: value.cipher,
    }),
    'utf8',
  );
}

function assertCustody(pairingId: string, keyId: string, key: InteropKeyCustody, subject: string): void {
  if (pairingId !== key.pairingId || keyId !== key.keyId) {
    throw new SealedInteropError(`${subject} does not match key custody.`, 'wrong-key');
  }
}

export function sealInteropMessage(envelopeInput: InteropEnvelope, key: InteropKeyCustody, options: SealInteropOptions = {}): Buffer {
  assertKey(key);
  const envelope = interopEnvelopeSchema.parse(envelopeInput);
  if (envelope.header.pairingId !== key.pairingId) {
    throw new SealedInteropError('Interop message pairing does not match key custody.', 'wrong-key');
  }
  const iv = ownedIv(options.iv);
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
  let aad: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  try {
    const authenticated = {
      magic: INTEROP_SEALED_MESSAGE_MAGIC,
      schemaVersion: INTEROP_SEALED_TRANSPORT_VERSION,
      pairingId: envelope.header.pairingId,
      transferId: envelope.header.transferId,
      messageId: envelope.header.messageId,
      keyId: key.keyId,
      cipher: { name: 'AES-GCM' as const, iv: iv.toString('base64') },
    } as const;
    aad = messageAad(authenticated);
    const cipher = createCipheriv('aes-256-gcm', key.interopKey, iv, { authTagLength: AES_TAG_BYTES });
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const sealed = interopSealedMessageSchema.parse({
      ...authenticated,
      cipher: { ...authenticated.cipher, ciphertext: ciphertext.toString('base64') },
    });
    return Buffer.from(JSON.stringify(sealed), 'utf8');
  } finally {
    ciphertext?.fill(0);
    aad?.fill(0);
    plaintext.fill(0);
    iv.fill(0);
  }
}

export function openInteropMessage(sealedBytes: Uint8Array, key: InteropKeyCustody): InteropEnvelope {
  assertKey(key);
  const value = parseJson(sealedBytes, 'Encrypted interop message');
  rejectUnsupportedVersion(value, INTEROP_SEALED_MESSAGE_MAGIC, 'Encrypted interop message');
  const parsed = interopSealedMessageSchema.safeParse(value);
  if (!parsed.success) throw new SealedInteropError('Encrypted interop message is invalid.', 'corrupt');
  const sealed = parsed.data;
  assertCustody(sealed.pairingId, sealed.keyId, key, 'Encrypted interop message');
  const iv = Buffer.from(sealed.cipher.iv, 'base64');
  const encrypted = Buffer.from(sealed.cipher.ciphertext, 'base64');
  const ciphertext = encrypted.subarray(0, encrypted.length - AES_TAG_BYTES);
  const authTag = encrypted.subarray(encrypted.length - AES_TAG_BYTES);
  const aad = messageAad({ ...sealed, cipher: { name: sealed.cipher.name, iv: sealed.cipher.iv } });
  let plaintext: Buffer | null = null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.interopKey, iv, { authTagLength: AES_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const envelope = interopEnvelopeSchema.parse(parseJson(plaintext, 'Encrypted interop message payload'));
    if (
      envelope.header.pairingId !== sealed.pairingId ||
      envelope.header.transferId !== sealed.transferId ||
      envelope.header.messageId !== sealed.messageId
    ) {
      throw new SealedInteropError('Encrypted interop message identity does not match its authenticated header.', 'corrupt');
    }
    return envelope;
  } catch (error) {
    if (error instanceof SealedInteropError) throw error;
    throw new SealedInteropError('Encrypted interop message could not be opened.', 'corrupt');
  } finally {
    plaintext?.fill(0);
    aad.fill(0);
    encrypted.fill(0);
    iv.fill(0);
  }
}

function encodeFrame(header: Uint8Array, payload: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(4 + header.byteLength + payload.byteLength);
  output.writeUInt32BE(header.byteLength, 0);
  output.set(header, 4);
  output.set(payload, 4 + header.byteLength);
  return output;
}

function decodeFrame(file: Uint8Array, subject: string): { readonly header: Buffer; readonly payload: Buffer } {
  if (file.byteLength < 4) throw new SealedInteropError(`${subject} is too short.`, 'corrupt');
  const view = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const headerLength = view.readUInt32BE(0);
  if (headerLength === 0 || headerLength > INTEROP_SEALED_HEADER_MAX_BYTES || headerLength > file.byteLength - 4) {
    throw new SealedInteropError(`${subject} header is invalid.`, 'corrupt');
  }
  return {
    header: Buffer.from(view.subarray(4, 4 + headerLength)),
    payload: Buffer.from(view.subarray(4 + headerLength)),
  };
}

export function sealInteropBlob(input: {
  readonly key: InteropKeyCustody;
  readonly transferId: string;
  readonly recordInteropId: string;
  readonly blob: InteropBlobReference & { readonly state: 'available' };
  readonly bytes: Uint8Array;
  readonly options?: SealInteropOptions | undefined;
}): Buffer {
  assertKey(input.key);
  if (input.bytes.byteLength !== input.blob.byteLength || digest(input.bytes) !== input.blob.contentHash) {
    throw new SealedInteropError('Interop original bytes do not match the canonical blob reference.', 'corrupt');
  }
  const iv = ownedIv(input.options?.iv);
  let headerBytes: Buffer | null = null;
  let descriptorBytes: Buffer | null = null;
  let plaintext: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  try {
    const header = interopSealedBlobHeaderSchema.parse({
      magic: INTEROP_SEALED_BLOB_MAGIC,
      schemaVersion: INTEROP_SEALED_TRANSPORT_VERSION,
      pairingId: input.key.pairingId,
      keyId: input.key.keyId,
      cipher: { name: 'AES-GCM', iv: iv.toString('base64') },
    });
    const descriptor = interopSealedBlobDescriptorSchema.parse({
      schemaVersion: INTEROP_SEALED_TRANSPORT_VERSION,
      transferId: input.transferId,
      recordInteropId: input.recordInteropId,
      role: 'original',
      blobId: input.blob.blobId,
      mimeType: input.blob.mimeType,
      byteLength: input.blob.byteLength,
      contentHash: input.blob.contentHash,
    });
    headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    descriptorBytes = Buffer.from(JSON.stringify(descriptor), 'utf8');
    if (headerBytes.length > INTEROP_SEALED_HEADER_MAX_BYTES || descriptorBytes.length > INTEROP_SEALED_HEADER_MAX_BYTES) {
      throw new SealedInteropError('Encrypted interop blob metadata is too large.', 'corrupt');
    }
    plaintext = encodeFrame(descriptorBytes, input.bytes);
    const cipher = createCipheriv('aes-256-gcm', input.key.interopKey, iv, { authTagLength: AES_TAG_BYTES });
    cipher.setAAD(headerBytes);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return encodeFrame(headerBytes, ciphertext);
  } finally {
    ciphertext?.fill(0);
    plaintext?.fill(0);
    descriptorBytes?.fill(0);
    headerBytes?.fill(0);
    iv.fill(0);
  }
}

export function openInteropBlob(
  file: Uint8Array,
  key: InteropKeyCustody,
): { readonly header: InteropSealedBlobHeader; readonly descriptor: InteropSealedBlobDescriptor; readonly bytes: Buffer } {
  assertKey(key);
  const outer = decodeFrame(file, 'Encrypted interop blob');
  let iv: Buffer | null = null;
  let plaintext: Buffer | null = null;
  let descriptorBytes: Buffer | null = null;
  let original: Buffer | null = null;
  try {
    const headerValue = parseJson(outer.header, 'Encrypted interop blob header');
    rejectUnsupportedVersion(headerValue, INTEROP_SEALED_BLOB_MAGIC, 'Encrypted interop blob');
    const parsed = interopSealedBlobHeaderSchema.safeParse(headerValue);
    if (!parsed.success) throw new SealedInteropError('Encrypted interop blob header is invalid.', 'corrupt');
    const header = parsed.data;
    assertCustody(header.pairingId, header.keyId, key, 'Encrypted interop blob');
    if (outer.payload.length <= AES_TAG_BYTES) {
      throw new SealedInteropError('Encrypted interop blob ciphertext is invalid.', 'corrupt');
    }
    iv = Buffer.from(header.cipher.iv, 'base64');
    const ciphertext = outer.payload.subarray(0, outer.payload.length - AES_TAG_BYTES);
    const authTag = outer.payload.subarray(outer.payload.length - AES_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key.interopKey, iv, { authTagLength: AES_TAG_BYTES });
    decipher.setAAD(outer.header);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const inner = decodeFrame(plaintext, 'Encrypted interop blob descriptor');
    descriptorBytes = inner.header;
    original = inner.payload;
    const descriptor = interopSealedBlobDescriptorSchema.parse(parseJson(descriptorBytes, 'Encrypted interop blob descriptor'));
    if (original.length !== descriptor.byteLength || digest(original) !== descriptor.contentHash) {
      throw new SealedInteropError('Encrypted interop blob content verification failed.', 'corrupt');
    }
    return { header, descriptor, bytes: Buffer.from(original) };
  } catch (error) {
    if (error instanceof SealedInteropError) throw error;
    throw new SealedInteropError('Encrypted interop blob could not be opened.', 'corrupt');
  } finally {
    original?.fill(0);
    descriptorBytes?.fill(0);
    plaintext?.fill(0);
    outer.payload.fill(0);
    outer.header.fill(0);
    iv?.fill(0);
  }
}
