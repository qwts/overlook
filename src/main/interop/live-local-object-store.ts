import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  INTEROP_CHUNK_BYTES,
  InteropTransportError,
  assertSafeInteropPath,
  type InteropObjectPage,
  type InteropObjectStore,
} from './transport.js';

const HEADER_RESERVE_BYTES = 2048;
const WIRE_CHUNK_BYTES = INTEROP_CHUNK_BYTES - HEADER_RESERVE_BYTES;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const objectHeaderSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('encrypted-object-chunk'),
    path: z.string().min(1),
    objectBytes: z.number().int().nonnegative().max(MAX_OBJECT_BYTES),
    objectSha256: sha256Schema,
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    chunkBytes: z.number().int().nonnegative().max(WIRE_CHUNK_BYTES),
    chunkSha256: sha256Schema,
  })
  .strict()
  .refine((value) => value.chunkIndex < value.chunkCount, 'Live local chunk index is outside its object.');

type ObjectHeader = z.output<typeof objectHeaderSchema>;

interface IncomingObject {
  readonly header: ObjectHeader;
  readonly chunks: Map<number, Buffer>;
}

interface PendingAcknowledgement {
  readonly sha256: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function encodeLiveLocalObjectChunk(headerInput: ObjectHeader, payloadInput: Uint8Array): Buffer {
  const payload = Buffer.from(payloadInput);
  const header = objectHeaderSchema.parse(headerInput);
  if (payload.length !== header.chunkBytes || digest(payload) !== header.chunkSha256) {
    throw new InteropTransportError('Live local chunk did not match its authenticated descriptor.', 'corrupt', false);
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length > HEADER_RESERVE_BYTES) {
    throw new InteropTransportError('Live local object header exceeds its bound.', 'corrupt', false);
  }
  const output = Buffer.allocUnsafe(4 + headerBytes.length + payload.length);
  output.writeUInt32BE(headerBytes.length, 0);
  output.set(headerBytes, 4);
  output.set(payload, 4 + headerBytes.length);
  return output;
}

export function decodeLiveLocalObjectChunk(frame: Uint8Array): { readonly header: ObjectHeader; readonly payload: Buffer } {
  const bytes = Buffer.from(frame);
  if (bytes.length < 5 || bytes.length > INTEROP_CHUNK_BYTES) {
    throw new InteropTransportError('Live local object frame exceeds its bound.', 'corrupt', false);
  }
  const headerBytes = bytes.readUInt32BE(0);
  if (headerBytes < 1 || headerBytes > HEADER_RESERVE_BYTES || headerBytes > bytes.length - 4) {
    throw new InteropTransportError('Live local object frame header is invalid.', 'corrupt', false);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.subarray(4, 4 + headerBytes).toString('utf8')) as unknown;
  } catch {
    throw new InteropTransportError('Live local object frame header is not JSON.', 'corrupt', false);
  }
  const header = objectHeaderSchema.parse(value);
  const payload = Buffer.from(bytes.subarray(4 + headerBytes));
  if (payload.length !== header.chunkBytes || digest(payload) !== header.chunkSha256) {
    payload.fill(0);
    throw new InteropTransportError('Live local object chunk failed verification.', 'corrupt', false);
  }
  return { header: { ...header, path: assertSafeInteropPath(header.path) }, payload };
}

/** Session-scoped object store. It implements the same encrypted-object seam
 * as cloud providers but never reads or writes a provider namespace. */
export class LiveLocalObjectStore implements InteropObjectStore {
  readonly provider = 'local-overlook' as const;
  readonly #objects = new Map<string, Buffer>();
  readonly #incoming = new Map<string, IncomingObject>();
  readonly #pending = new Map<string, PendingAcknowledgement>();
  #closed = false;

  constructor(private readonly session: { readonly sendBinary: (value: Buffer) => void }) {}

  authState(): Promise<'connected'> {
    return Promise.resolve('connected');
  }

  async put(pathInput: string, bytesInput: Buffer): Promise<{ readonly bytes: number }> {
    this.assertOpen();
    const path = assertSafeInteropPath(pathInput);
    const bytes = Buffer.from(bytesInput);
    const sha256 = digest(bytes);
    const chunkCount = Math.max(1, Math.ceil(bytes.length / WIRE_CHUNK_BYTES));
    const acknowledgement = new Promise<void>((resolve, reject) => {
      this.#pending.set(path, { sha256, resolve, reject });
    });
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      this.assertOpen();
      const payload = bytes.subarray(chunkIndex * WIRE_CHUNK_BYTES, Math.min(bytes.length, (chunkIndex + 1) * WIRE_CHUNK_BYTES));
      this.session.sendBinary(
        encodeLiveLocalObjectChunk(
          {
            schemaVersion: 1,
            type: 'encrypted-object-chunk',
            path,
            objectBytes: bytes.length,
            objectSha256: sha256,
            chunkIndex,
            chunkCount,
            chunkBytes: payload.length,
            chunkSha256: digest(payload),
          },
          payload,
        ),
      );
    }
    await acknowledgement;
    this.#objects.set(path, bytes);
    return { bytes: bytes.length };
  }

  get(pathInput: string): Promise<Buffer> {
    const path = assertSafeInteropPath(pathInput);
    const value = this.#objects.get(path);
    if (value === undefined) return Promise.reject(new InteropTransportError('Local interop object was not found.', 'not-found', false));
    return Promise.resolve(Buffer.from(value));
  }

  list(prefixInput: string, cursor: string | null): Promise<InteropObjectPage> {
    const prefix = assertSafeInteropPath(prefixInput);
    const entries = [...this.#objects]
      .filter(([path]) => path.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => ({ path, bytes: bytes.length }));
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return Promise.reject(new InteropTransportError('Invalid local interoperability cursor.', 'corrupt', false));
    }
    const page = entries.slice(offset, offset + 100);
    return Promise.resolve({ entries: page, nextCursor: offset + page.length < entries.length ? String(offset + page.length) : null });
  }

  delete(pathInput: string): Promise<void> {
    this.#objects.delete(assertSafeInteropPath(pathInput));
    return Promise.resolve();
  }

  quota(): Promise<{ readonly usedBytes: number; readonly totalBytes: null }> {
    return Promise.resolve({ usedBytes: [...this.#objects.values()].reduce((total, bytes) => total + bytes.length, 0), totalBytes: null });
  }

  async verify(pathInput: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
    const bytes = await this.get(pathInput);
    return { sha256: digest(bytes), bytes: bytes.length };
  }

  receive(frame: Uint8Array): { readonly path: string; readonly sha256: string } | null {
    this.assertOpen();
    const { header, payload } = decodeLiveLocalObjectChunk(frame);
    const existing = this.#incoming.get(header.path);
    if (
      existing !== undefined &&
      (existing.header.objectBytes !== header.objectBytes ||
        existing.header.objectSha256 !== header.objectSha256 ||
        existing.header.chunkCount !== header.chunkCount)
    ) {
      payload.fill(0);
      throw new InteropTransportError('Live local object identity was replayed with different content.', 'corrupt', false);
    }
    const incoming = existing ?? { header, chunks: new Map<number, Buffer>() };
    const prior = incoming.chunks.get(header.chunkIndex);
    if (prior !== undefined && !prior.equals(payload)) {
      payload.fill(0);
      throw new InteropTransportError('Live local chunk identity was replayed with different content.', 'corrupt', false);
    }
    if (prior === undefined) incoming.chunks.set(header.chunkIndex, payload);
    else payload.fill(0);
    this.#incoming.set(header.path, incoming);
    if (incoming.chunks.size !== header.chunkCount) return null;
    const chunks = [...incoming.chunks.entries()].sort(([left], [right]) => left - right).map(([, chunk]) => chunk);
    const object = Buffer.concat(chunks);
    if (object.length !== header.objectBytes || digest(object) !== header.objectSha256) {
      object.fill(0);
      throw new InteropTransportError('Live local encrypted object failed whole-object verification.', 'corrupt', false);
    }
    this.#objects.set(header.path, object);
    this.#incoming.delete(header.path);
    for (const chunk of chunks) chunk.fill(0);
    return { path: header.path, sha256: header.objectSha256 };
  }

  acknowledge(pathInput: string, sha256: string): void {
    const path = assertSafeInteropPath(pathInput);
    const pending = this.#pending.get(path);
    if (pending === undefined || pending.sha256 !== sha256) {
      throw new InteropTransportError('Live local acknowledgement did not match an outstanding object.', 'corrupt', false);
    }
    this.#pending.delete(path);
    pending.resolve();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new InteropTransportError('Live local peer disappeared before durable acknowledgement.', 'offline', true);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const bytes of this.#objects.values()) bytes.fill(0);
    this.#objects.clear();
    for (const incoming of this.#incoming.values()) for (const chunk of incoming.chunks.values()) chunk.fill(0);
    this.#incoming.clear();
  }

  private assertOpen(): void {
    if (this.#closed) throw new InteropTransportError('Live local session is closed.', 'offline', true);
  }
}
