import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';

// Streaming AES-256-GCM envelopes per ADR-0004 §cipher/envelope (#67).
// Pure Node — no Electron imports — so node:test exercises every branch.
//
// Envelope layout:
//   header : magic "OVLK" | format u8 | key id u32be | nonce prefix (8 bytes)
//   chunk  : flags u8 (bit0 = final) | total chunks u32be (0 unless final) |
//            ciphertext length u32be | GCM tag (16) | ciphertext
//
// Nonce = per-blob random 64-bit prefix + 32-bit chunk counter (never reused
// within a key at our volumes). AAD binds photo id, key id, chunk index, the
// final flag, and the declared total — so reordering, substitution, and
// truncation all fail authentication loudly.

export const ENVELOPE_FORMAT_VERSION = 1;
export const CHUNK_SIZE = 4 * 1024 * 1024;

const MAGIC = Buffer.from('OVLK', 'ascii');
const AUTH_TAG_BYTES = 16;
const HEADER_LENGTH = MAGIC.length + 1 + 4 + 8;
const CHUNK_PREFIX_LENGTH = 1 + 4 + 4 + AUTH_TAG_BYTES;
const FLAG_FINAL = 0b0000_0001;
// Decrypt-side guard: a forged length cannot make us buffer unbounded input.
const MAX_CHUNK_LENGTH = 2 * CHUNK_SIZE;

export interface EnvelopeKey {
  /** ADR-0004 versioned library key id (the Inspector's "KEY #N"). */
  readonly id: number;
  /** 32-byte AES-256 key. */
  readonly key: Buffer;
  /**
   * Reserves a unique 64-bit prefix before an envelope is written. Production
   * library keys provide this through KeyStore; isolated keys retain the
   * legacy random-prefix behavior for compatibility.
   */
  readonly reserveNoncePrefix?: () => Buffer;
}

export interface EnvelopeContext {
  /** Photo id bound into every chunk's AAD. */
  readonly photoId: string;
}

/** Returns the wrapped key bytes for a key id, or undefined if unknown. */
export type KeyResolver = (keyId: number) => Buffer | undefined;

export class EnvelopeError extends Error {
  override readonly name = 'EnvelopeError';
}

function assertKeyBytes(key: Buffer): void {
  if (key.length !== 32) {
    throw new EnvelopeError(`AES-256 key must be 32 bytes, got ${String(key.length)}`);
  }
}

function nonceFor(prefix: Buffer, chunkIndex: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(chunkIndex, 8);
  return nonce;
}

function aadFor(context: EnvelopeContext, keyId: number, chunkIndex: number, flags: number, totalChunks: number): Buffer {
  const photoId = Buffer.from(context.photoId, 'utf8');
  const fixed = Buffer.alloc(13);
  fixed.writeUInt32BE(keyId, 0);
  fixed.writeUInt32BE(chunkIndex, 4);
  fixed.writeUInt8(flags, 8);
  fixed.writeUInt32BE(totalChunks, 9);
  return Buffer.concat([photoId, fixed]);
}

function sealChunk(
  key: EnvelopeKey,
  noncePrefix: Buffer,
  context: EnvelopeContext,
  chunkIndex: number,
  plaintext: Buffer,
  final: boolean,
  totalChunks: number,
): Buffer {
  const flags = final ? FLAG_FINAL : 0;
  const cipher = createCipheriv('aes-256-gcm', key.key, nonceFor(noncePrefix, chunkIndex), { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aadFor(context, key.id, chunkIndex, flags, totalChunks));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const prefix = Buffer.alloc(CHUNK_PREFIX_LENGTH);
  prefix.writeUInt8(flags, 0);
  prefix.writeUInt32BE(totalChunks, 1);
  prefix.writeUInt32BE(ciphertext.length, 5);
  cipher.getAuthTag().copy(prefix, 9);
  return Buffer.concat([prefix, ciphertext]);
}

/** Encrypts a plaintext stream into an envelope. */
export function createEncryptStream(key: EnvelopeKey, context: EnvelopeContext, options: { readonly chunkSize?: number } = {}): Transform {
  assertKeyBytes(key.key);
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  if (chunkSize <= 0) {
    throw new EnvelopeError('chunkSize must be positive');
  }
  if (chunkSize > MAX_CHUNK_LENGTH) {
    throw new EnvelopeError(`chunkSize ${String(chunkSize)} exceeds the decryptable maximum of ${String(MAX_CHUNK_LENGTH)}`);
  }
  const noncePrefix = key.reserveNoncePrefix?.() ?? randomBytes(8);
  if (noncePrefix.length !== 8) {
    throw new EnvelopeError(`nonce prefix must be 8 bytes, got ${String(noncePrefix.length)}`);
  }
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let chunkIndex = 0;
  let headerWritten = false;

  const writeHeader = (push: (data: Buffer) => void): void => {
    const header = Buffer.alloc(HEADER_LENGTH);
    MAGIC.copy(header, 0);
    header.writeUInt8(ENVELOPE_FORMAT_VERSION, MAGIC.length);
    header.writeUInt32BE(key.id, MAGIC.length + 1);
    noncePrefix.copy(header, MAGIC.length + 5);
    push(header);
    headerWritten = true;
  };

  return new Transform({
    transform(data: Buffer, _encoding, callback): void {
      try {
        if (!headerWritten) {
          writeHeader((b) => this.push(b));
        }
        pending.push(data);
        pendingLength += data.length;
        while (pendingLength >= chunkSize) {
          const joined = Buffer.concat(pending, pendingLength);
          const plaintext = joined.subarray(0, chunkSize);
          const rest = joined.subarray(chunkSize);
          pending = rest.length > 0 ? [Buffer.from(rest)] : [];
          pendingLength = rest.length;
          this.push(sealChunk(key, noncePrefix, context, chunkIndex, Buffer.from(plaintext), false, 0));
          chunkIndex += 1;
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new EnvelopeError(String(error)));
      }
    },
    flush(callback): void {
      try {
        if (!headerWritten) {
          writeHeader((b) => this.push(b));
        }
        const plaintext = Buffer.concat(pending, pendingLength);
        const totalChunks = chunkIndex + 1;
        this.push(sealChunk(key, noncePrefix, context, chunkIndex, plaintext, true, totalChunks));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new EnvelopeError(String(error)));
      }
    },
  });
}

/** Decrypts an envelope stream; resolveKey supports cross-key-version reads. */
export function createDecryptStream(resolveKey: KeyResolver, context: EnvelopeContext): Transform {
  let buffered = Buffer.alloc(0);
  let headerParsed = false;
  let key: Buffer | undefined;
  let keyId = 0;
  let noncePrefix = Buffer.alloc(0);
  let chunkIndex = 0;
  let finalSeen = false;

  const parseHeader = (): boolean => {
    if (buffered.length < HEADER_LENGTH) {
      return false;
    }
    if (!buffered.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new EnvelopeError('not an Overlook envelope (bad magic)');
    }
    const version = buffered.readUInt8(MAGIC.length);
    if (version !== ENVELOPE_FORMAT_VERSION) {
      throw new EnvelopeError(`unsupported envelope format version ${String(version)}`);
    }
    keyId = buffered.readUInt32BE(MAGIC.length + 1);
    key = resolveKey(keyId);
    if (key === undefined) {
      throw new EnvelopeError(`no key available for key id ${String(keyId)}`);
    }
    assertKeyBytes(key);
    noncePrefix = Buffer.from(buffered.subarray(MAGIC.length + 5, HEADER_LENGTH));
    buffered = Buffer.from(buffered.subarray(HEADER_LENGTH));
    headerParsed = true;
    return true;
  };

  const openChunk = (push: (data: Buffer) => void): boolean => {
    if (buffered.length < CHUNK_PREFIX_LENGTH) {
      return false;
    }
    const flags = buffered.readUInt8(0);
    const totalChunks = buffered.readUInt32BE(1);
    const length = buffered.readUInt32BE(5);
    if (length > MAX_CHUNK_LENGTH) {
      throw new EnvelopeError(`chunk length ${String(length)} exceeds the envelope maximum`);
    }
    if (buffered.length < CHUNK_PREFIX_LENGTH + length) {
      return false;
    }
    if (finalSeen) {
      throw new EnvelopeError('data after the final chunk');
    }
    const tag = buffered.subarray(9, 25);
    const ciphertext = buffered.subarray(CHUNK_PREFIX_LENGTH, CHUNK_PREFIX_LENGTH + length);
    const final = (flags & FLAG_FINAL) !== 0;
    if (key === undefined) {
      throw new EnvelopeError('decrypt reached a chunk before the header');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(noncePrefix, chunkIndex), { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aadFor(context, keyId, chunkIndex, flags, totalChunks));
    decipher.setAuthTag(tag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new EnvelopeError(`chunk ${String(chunkIndex)} failed authentication (tampered, reordered, or wrong context)`);
    }
    if (final) {
      if (totalChunks !== chunkIndex + 1) {
        throw new EnvelopeError(`final chunk declares ${String(totalChunks)} chunks but ${String(chunkIndex + 1)} arrived`);
      }
      finalSeen = true;
    }
    buffered = Buffer.from(buffered.subarray(CHUNK_PREFIX_LENGTH + length));
    chunkIndex += 1;
    if (plaintext.length > 0) {
      push(plaintext);
    }
    return true;
  };

  return new Transform({
    transform(data: Buffer, _encoding, callback): void {
      try {
        buffered = buffered.length === 0 ? Buffer.from(data) : Buffer.concat([buffered, data]);
        if (!headerParsed && !parseHeader()) {
          callback();
          return;
        }
        while (openChunk((b) => this.push(b))) {
          // keep draining complete chunks
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new EnvelopeError(String(error)));
      }
    },
    flush(callback): void {
      if (!headerParsed || !finalSeen || buffered.length > 0) {
        callback(new EnvelopeError('truncated envelope (ended before the final chunk completed)'));
        return;
      }
      callback();
    },
  });
}
