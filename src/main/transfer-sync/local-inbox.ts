import { createHash, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local Transfer & Sync inbox: a loopback-only HTTP endpoint that accepts
 * encrypted originals from Image Trail on the same machine and feeds them to
 * the standard import chain. The one-time sync string shown in Settings is the
 * whole handshake: it encodes the listening port and a 32-byte secret from
 * which both the request auth token and the payload key are derived.
 */

const SYNC_STRING_PREFIX = 'OV1.';
const SECRET_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 512 * 1024 * 1024;
const AUTH_INFO = 'overlook-transfer-v1/auth';
const KEY_INFO = 'overlook-transfer-v1/key';

export interface LocalInboxCredentials {
  readonly port: number;
  readonly secret: Buffer;
}

export function createSyncString(credentials: LocalInboxCredentials): string {
  if (credentials.secret.byteLength !== SECRET_BYTES) throw new Error('Sync secret must be 32 bytes.');
  if (!Number.isInteger(credentials.port) || credentials.port < 1 || credentials.port > 65535) throw new Error('Sync port is invalid.');
  const packed = Buffer.alloc(2 + SECRET_BYTES);
  packed.writeUInt16BE(credentials.port, 0);
  credentials.secret.copy(packed, 2);
  return `${SYNC_STRING_PREFIX}${packed.toString('base64url')}`;
}

export function parseSyncString(value: string): LocalInboxCredentials {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SYNC_STRING_PREFIX)) throw new Error('Unrecognized sync string.');
  const packed = Buffer.from(trimmed.slice(SYNC_STRING_PREFIX.length), 'base64url');
  if (packed.byteLength !== 2 + SECRET_BYTES) throw new Error('Sync string is incomplete.');
  const port = packed.readUInt16BE(0);
  if (port < 1) throw new Error('Sync string port is invalid.');
  return { port, secret: packed.subarray(2) };
}

export function deriveAuthToken(secret: Buffer): string {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), AUTH_INFO, 32)).toString('hex');
}

export function derivePayloadKey(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, 32));
}

export interface TransferMeta {
  readonly name: string;
  readonly iv: string;
  readonly sha256: string;
}

function parseMeta(header: string | string[] | undefined): TransferMeta {
  if (typeof header !== 'string' || header === '') throw new Error('Missing transfer metadata.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Unreadable transfer metadata.');
  }
  const meta = parsed as Partial<TransferMeta>;
  if (
    typeof meta.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u.test(meta.name) ||
    meta.name.includes('..') ||
    typeof meta.iv !== 'string' ||
    typeof meta.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(meta.sha256)
  )
    throw new Error('Invalid transfer metadata.');
  return { name: meta.name, iv: meta.iv, sha256: meta.sha256 };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_CIPHERTEXT_BYTES) {
        reject(new Error('Transfer payload is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
}

function decryptPayload(key: Buffer, meta: TransferMeta, ciphertext: Buffer): Buffer {
  const iv = Buffer.from(meta.iv, 'base64url');
  if (iv.byteLength !== IV_BYTES) throw new Error('Invalid transfer IV.');
  if (ciphertext.byteLength <= GCM_TAG_BYTES) throw new Error('Transfer payload is truncated.');
  const tag = ciphertext.subarray(ciphertext.byteLength - GCM_TAG_BYTES);
  const sealed = ciphertext.subarray(0, ciphertext.byteLength - GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(sealed), decipher.final()]);
  const digest = createHash('sha256').update(plaintext).digest('hex');
  if (digest !== meta.sha256) throw new Error('Transfer checksum mismatch.');
  return plaintext;
}

export interface LocalInboxOptions {
  /** Feeds the standard import chain; receives a staged plaintext file path. */
  readonly importFiles: (paths: readonly string[]) => Promise<unknown>;
  readonly secret?: Buffer;
  readonly stagingRoot?: string;
}

export interface LocalInbox {
  readonly syncString: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startLocalInbox(options: LocalInboxOptions): Promise<LocalInbox> {
  const secret = options.secret ?? randomBytes(SECRET_BYTES);
  const authToken = deriveAuthToken(secret);
  const payloadKey = derivePayloadKey(secret);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const reply = (status: number, body: Record<string, unknown>): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || request.url !== '/v1/transfer') {
      reply(404, { ok: false });
      return;
    }
    if (!authorized(request, authToken)) {
      reply(401, { ok: false });
      return;
    }
    let staging: string | null = null;
    try {
      const meta = parseMeta(request.headers['x-transfer-meta']);
      const plaintext = decryptPayload(payloadKey, meta, await readBody(request));
      staging = mkdtempSync(join(options.stagingRoot ?? tmpdir(), 'overlook-transfer-'));
      const staged = join(staging, meta.name);
      writeFileSync(staged, plaintext, { mode: 0o600 });
      await options.importFiles([staged]);
      reply(200, { ok: true });
    } catch (error) {
      reply(400, { ok: false, error: error instanceof Error ? error.message : 'Transfer failed.' });
    } finally {
      if (staging !== null) rmSync(staging, { recursive: true, force: true });
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Local transfer inbox failed to bind.');
  }
  return {
    syncString: createSyncString({ port: address.port, secret }),
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
