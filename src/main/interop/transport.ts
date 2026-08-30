import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { z } from 'zod';

import { GoogleDriveProvider, type GoogleDriveProviderOptions } from '../backup/google-drive/google-drive-provider.js';
export { GOOGLE_DRIVE_DISCOVERY_PROTOCOL } from '../backup/google-drive/discovery-protocol.js';
import { PCloudProvider, type PCloudProviderOptions } from '../backup/pcloud/pcloud-provider.js';
import { ProviderError, type StorageProvider } from '../backup/provider.js';

export const INTEROP_CHUNK_BYTES = 4 * 1024 * 1024;
export const INTEROP_CONTROL_FRAME_BYTES = 64 * 1024;
export const INTEROP_PROVIDER_ROOT_NAME = 'Overlook Interop';
export const INTEROP_PROVIDER_LIBRARY_ID = 'v1';
export const INTEROP_PROVIDER_LOGICAL_ROOT = `${INTEROP_PROVIDER_ROOT_NAME}/${INTEROP_PROVIDER_LIBRARY_ID}`;
export const INTEROP_GOOGLE_DRIVE_OWNER = 'qwts-overlook-interop-v1';

export type InteropTransportFailure =
  'offline' | 'auth-expired' | 'quota' | 'provider-unavailable' | 'partial-failure' | 'not-found' | 'corrupt' | 'unsupported';

export class InteropTransportError extends Error {
  constructor(
    message: string,
    readonly code: InteropTransportFailure,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'InteropTransportError';
  }
}

const safePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes(':') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Interop paths must be provider-relative and traversal-free.',
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const scopeSchema = z.object({ pairingId: z.string().uuid(), transferId: z.string().uuid() });
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  pairingId: z.string().uuid(),
  transferId: z.string().uuid(),
  path: safePathSchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
  chunks: z.array(
    z.object({
      index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      bytes: z.number().int().nonnegative().max(INTEROP_CHUNK_BYTES),
      sha256: sha256Schema,
    }),
  ),
});

export type InteropTransportScope = z.output<typeof scopeSchema>;

export interface InteropObjectPage {
  readonly entries: readonly { readonly path: string; readonly bytes: number }[];
  readonly nextCursor: string | null;
}

export interface InteropObjectStore {
  readonly provider: 'pcloud' | 'google-drive' | 'icloud' | 'local-overlook';
  authState(): Promise<'connected' | 'not-connected' | 'expired'>;
  put(path: string, bytes: Buffer): Promise<{ readonly bytes: number }>;
  get(path: string): Promise<Buffer>;
  list(prefix: string, cursor: string | null): Promise<InteropObjectPage>;
  delete(path: string): Promise<void>;
  quota(): Promise<{ readonly usedBytes: number; readonly totalBytes: number | null }>;
  verify(path: string): Promise<{ readonly sha256: string; readonly bytes: number }>;
}

export function assertSafeInteropPath(path: string): string {
  return safePathSchema.parse(path);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mapProviderError(error: unknown): never {
  if (!(error instanceof ProviderError)) throw error;
  if (error.kind === 'auth') throw new InteropTransportError('Interop provider authorization expired.', 'auth-expired', false);
  if (error.kind === 'quota') throw new InteropTransportError('Interop provider quota is exhausted.', 'quota', false);
  if (error.kind === 'not-found') throw new InteropTransportError('Interop object was not found.', 'not-found', false);
  if (error.kind === 'corrupt') throw new InteropTransportError('Interop provider returned corrupt data.', 'corrupt', false);
  throw new InteropTransportError('Interop provider is temporarily unavailable.', 'provider-unavailable', true);
}

/** Narrows a StorageProvider to its dedicated interop root and hides library discovery. */
export class StorageProviderInteropObjectStore implements InteropObjectStore {
  readonly provider: 'pcloud' | 'google-drive';

  constructor(private readonly storage: StorageProvider) {
    if (storage.id !== 'pcloud' && storage.id !== 'google-drive')
      throw new InteropTransportError('Unsupported interoperability storage provider.', 'unsupported', false);
    this.provider = storage.id;
  }

  authState(): Promise<'connected' | 'not-connected' | 'expired'> {
    return this.storage.authState();
  }
  async put(path: string, bytes: Buffer): Promise<{ readonly bytes: number }> {
    try {
      return await this.storage.put(assertSafeInteropPath(path), Readable.from([bytes]));
    } catch (error) {
      mapProviderError(error);
    }
  }
  async get(path: string): Promise<Buffer> {
    try {
      return await buffer(await this.storage.getStream(assertSafeInteropPath(path)));
    } catch (error) {
      mapProviderError(error);
    }
  }
  async list(prefix: string, cursor: string | null): Promise<InteropObjectPage> {
    try {
      const entries = [...(await this.storage.list(assertSafeInteropPath(prefix)))].sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new InteropTransportError('Invalid interoperability cursor.', 'corrupt', false);
      const page = entries.slice(offset, offset + 100);
      return { entries: page, nextCursor: offset + page.length < entries.length ? String(offset + page.length) : null };
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      mapProviderError(error);
    }
  }
  async delete(path: string): Promise<void> {
    try {
      await this.storage.delete(assertSafeInteropPath(path));
    } catch (error) {
      mapProviderError(error);
    }
  }
  async quota(): Promise<{ readonly usedBytes: number; readonly totalBytes: number | null }> {
    try {
      return await this.storage.quota();
    } catch (error) {
      mapProviderError(error);
    }
  }
  async verify(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
    try {
      return await this.storage.verify(assertSafeInteropPath(path));
    } catch (error) {
      mapProviderError(error);
    }
  }
}

export function createPCloudInteropStore(options: Omit<PCloudProviderOptions, 'libraryId' | 'rootName'>): InteropObjectStore {
  return new StorageProviderInteropObjectStore(
    new PCloudProvider({ ...options, libraryId: INTEROP_PROVIDER_LIBRARY_ID, rootName: INTEROP_PROVIDER_ROOT_NAME }),
  );
}

export function createGoogleDriveInteropStore(
  options: Omit<GoogleDriveProviderOptions, 'libraryId' | 'rootName' | 'owner'>,
): InteropObjectStore {
  return new StorageProviderInteropObjectStore(
    new GoogleDriveProvider({
      ...options,
      libraryId: INTEROP_PROVIDER_LIBRARY_ID,
      rootName: INTEROP_PROVIDER_ROOT_NAME,
      owner: INTEROP_GOOGLE_DRIVE_OWNER,
    }),
  );
}

function scopePath(scopeInput: InteropTransportScope): string {
  const scope = scopeSchema.parse(scopeInput);
  return `pairings/${scope.pairingId}/transfers/${scope.transferId}`;
}

function objectKey(scope: InteropTransportScope, pathInput: string): string {
  return `${scopePath(scope)}/objects/${assertSafeInteropPath(pathInput)}`;
}

function chunkKey(scope: InteropTransportScope, path: string, index: number): string {
  return `${objectKey(scope, path)}.chunks/${String(index).padStart(8, '0')}.bin`;
}

function manifestKey(scope: InteropTransportScope, path: string): string {
  return `${objectKey(scope, path)}.manifest.json`;
}

async function verified(
  store: InteropObjectStore,
  path: string,
  expected: { readonly sha256: string; readonly bytes: number },
): Promise<boolean> {
  try {
    const actual = await store.verify(path);
    return actual.bytes === expected.bytes && actual.sha256.toLowerCase() === expected.sha256;
  } catch (error) {
    if (error instanceof InteropTransportError && error.code === 'not-found') return false;
    throw error;
  }
}

export class EncryptedInteropTransport {
  constructor(
    private readonly store: InteropObjectStore,
    private readonly chunkBytes = INTEROP_CHUNK_BYTES,
  ) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > INTEROP_CHUNK_BYTES)
      throw new InteropTransportError('Invalid interoperability chunk size.', 'corrupt', false);
  }

  async upload(
    scope: InteropTransportScope,
    pathInput: string,
    ciphertext: Buffer,
    onProgress: (progress: { readonly completedChunks: number; readonly totalChunks: number }) => void = () => undefined,
  ): Promise<{ readonly sha256: string; readonly bytes: number; readonly resumedChunks: number }> {
    const path = assertSafeInteropPath(pathInput);
    const chunks: Array<{ index: number; bytes: number; sha256: string }> = [];
    const totalChunks = Math.max(1, Math.ceil(ciphertext.length / this.chunkBytes));
    let resumedChunks = 0;
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = ciphertext.subarray(index * this.chunkBytes, Math.min(ciphertext.length, (index + 1) * this.chunkBytes));
      const expected = { bytes: chunk.length, sha256: digest(chunk) };
      const key = chunkKey(scope, path, index);
      if (await verified(this.store, key, expected)) resumedChunks += 1;
      else {
        const stored = await this.store.put(key, chunk);
        if (stored.bytes !== chunk.length || !(await verified(this.store, key, expected)))
          throw new InteropTransportError(`Provider did not verify chunk ${String(index)}.`, 'partial-failure', true);
      }
      chunks.push({ index, ...expected });
      onProgress({ completedChunks: index + 1, totalChunks });
    }
    const manifest = manifestSchema.parse({
      schemaVersion: 1,
      ...scopeSchema.parse(scope),
      path,
      bytes: ciphertext.length,
      sha256: digest(ciphertext),
      chunks,
    });
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const key = manifestKey(scope, path);
    await this.store.put(key, bytes);
    if (!(await verified(this.store, key, { bytes: bytes.length, sha256: digest(bytes) })))
      throw new InteropTransportError('Provider did not verify the transfer manifest.', 'partial-failure', true);
    return { sha256: manifest.sha256, bytes: manifest.bytes, resumedChunks };
  }

  async download(scope: InteropTransportScope, pathInput: string): Promise<Buffer> {
    const path = assertSafeInteropPath(pathInput);
    let manifest: z.output<typeof manifestSchema>;
    try {
      manifest = manifestSchema.parse(JSON.parse((await this.store.get(manifestKey(scope, path))).toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw new InteropTransportError('Interop transfer manifest is invalid.', 'corrupt', false);
    }
    if (manifest.pairingId !== scope.pairingId || manifest.transferId !== scope.transferId || manifest.path !== path)
      throw new InteropTransportError('Interop transfer manifest crossed its reviewed scope.', 'corrupt', false);
    const chunks: Buffer[] = [];
    for (const chunk of manifest.chunks) {
      const bytes = await this.store.get(chunkKey(scope, path, chunk.index));
      if (bytes.length !== chunk.bytes || digest(bytes) !== chunk.sha256)
        throw new InteropTransportError(`Interop chunk ${String(chunk.index)} failed verification.`, 'corrupt', false);
      chunks.push(bytes);
    }
    const output = Buffer.concat(chunks);
    if (output.length !== manifest.bytes || digest(output) !== manifest.sha256)
      throw new InteropTransportError('Interop ciphertext failed whole-file verification.', 'corrupt', false);
    return output;
  }

  list(scope: InteropTransportScope, cursor: string | null = null): Promise<InteropObjectPage> {
    return this.store.list(`${scopePath(scope)}/objects`, cursor);
  }

  quota(): Promise<{ readonly usedBytes: number; readonly totalBytes: number | null }> {
    return this.store.quota();
  }
}

export function assertBoundedControlFrame(value: unknown): void {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (
    record === null ||
    'bytes' in record ||
    'ciphertext' in record ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > INTEROP_CONTROL_FRAME_BYTES
  )
    throw new InteropTransportError('Native control frame is invalid or contains payload bytes.', 'corrupt', false);
}
