import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { GoogleDriveAuthClient } from '../../src/main/backup/google-drive/auth-client.js';
import { GoogleDrivePathStore } from '../../src/main/backup/google-drive/path-store.js';
import { GoogleDriveTokenStore } from '../../src/main/backup/google-drive/token-store.js';
import type { PCloudAuthRecord } from '../../src/main/backup/pcloud/token-store.js';
import { ICloudNativeHost, nativeHostManifest } from '../../src/main/interop/icloud-native-host.js';
import {
  EncryptedInteropTransport,
  InteropTransportError,
  createGoogleDriveInteropStore,
  createPCloudInteropStore,
  type InteropObjectPage,
  type InteropObjectStore,
} from '../../src/main/interop/transport.js';

const SCOPE = {
  pairingId: 'f03e92fd-ad4a-41e6-aeaf-a65abde4c853',
  transferId: '35d06972-7453-4c53-8a32-e531e4ab43ed',
};
const RELEASED_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

function inputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function stringBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  return body;
}

class MemoryStore implements InteropObjectStore {
  readonly provider = 'pcloud' as const;
  readonly objects = new Map<string, Buffer>();
  puts = 0;
  authState(): Promise<'connected'> {
    return Promise.resolve('connected');
  }
  put(path: string, bytes: Buffer): Promise<{ readonly bytes: number }> {
    this.puts += 1;
    this.objects.set(path, Buffer.from(bytes));
    return Promise.resolve({ bytes: bytes.length });
  }
  get(path: string): Promise<Buffer> {
    const bytes = this.objects.get(path);
    return bytes === undefined
      ? Promise.reject(new InteropTransportError('missing', 'not-found', false))
      : Promise.resolve(Buffer.from(bytes));
  }
  list(prefix: string, cursor: string | null): Promise<InteropObjectPage> {
    const entries = [...this.objects.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, bytes]) => ({ path, bytes: bytes.length }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const offset = cursor === null ? 0 : Number(cursor);
    return Promise.resolve({
      entries: entries.slice(offset, offset + 2),
      nextCursor: offset + 2 < entries.length ? String(offset + 2) : null,
    });
  }
  delete(path: string): Promise<void> {
    this.objects.delete(path);
    return Promise.resolve();
  }
  quota(): Promise<{ readonly usedBytes: number; readonly totalBytes: number }> {
    return Promise.resolve({ usedBytes: 0, totalBytes: 1024 });
  }
  async verify(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
    const bytes = await this.get(path);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
}

describe('provider-neutral encrypted transport (#335)', () => {
  test('resumes verified chunks and fails closed on corruption', async () => {
    const store = new MemoryStore();
    const transport = new EncryptedInteropTransport(store, 3);
    const ciphertext = Buffer.from('encrypted-envelope-bytes');
    const first = await transport.upload(SCOPE, 'records/a.envelope', ciphertext);
    assert.equal(first.sha256, createHash('sha256').update(ciphertext).digest('hex'));
    const puts = store.puts;
    const resumed = await transport.upload(SCOPE, 'records/a.envelope', ciphertext);
    assert.equal(resumed.resumedChunks, Math.ceil(ciphertext.length / 3));
    assert.equal(store.puts, puts + 1);
    assert.deepEqual(await transport.download(SCOPE, 'records/a.envelope'), ciphertext);
    const chunk = [...store.objects.keys()].find((path) => path.endsWith('00000000.bin'));
    assert.ok(chunk);
    store.objects.set(chunk, Buffer.alloc(3, 9));
    await assert.rejects(
      transport.download(SCOPE, 'records/a.envelope'),
      (error: unknown) => error instanceof InteropTransportError && error.code === 'corrupt',
    );
  });
});

describe('pCloud and Drive namespace isolation (#335)', () => {
  test('pCloud writes below Overlook Interop and never the backup root', async () => {
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const method = inputUrl(input).pathname.slice(1);
      const body = init?.body;
      if (body instanceof FormData || body instanceof URLSearchParams) {
        const path = body.get('path');
        if (typeof path === 'string') paths.push(path);
      }
      if (method === 'uploadfile') return Response.json({ result: 0, metadata: [{ size: 3 }] });
      return Response.json({ result: 0, metadata: { isfolder: true } });
    };
    const record: PCloudAuthRecord = {
      accessToken: 'interop-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-16T00:00:00.000Z',
    };
    const store = createPCloudInteropStore({ auth: () => record, fetchImpl });
    await store.put('pairings/a/object.bin', Buffer.from([1, 2, 3]));
    assert.ok(paths.every((path) => path === '/Overlook Interop' || path.startsWith('/Overlook Interop/')));
    assert.ok(paths.some((path) => path.startsWith('/Overlook Interop/v1/')));
    assert.ok(paths.every((path) => !path.startsWith('/Overlook/')));
    assert.equal('listLibraries' in store, false, 'interop authority cannot enumerate backup libraries');
  });

  test('Drive creates a separate app-owned root and uses resumable upload', async () => {
    const created: Array<Record<string, unknown>> = [];
    let nextId = 1;
    const fetchImpl: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = inputUrl(input);
      if (url.hostname === 'www.googleapis.com' && url.pathname === '/upload/session')
        return Response.json({
          id: 'file-1',
          size: '3',
          sha256Checksum: createHash('sha256')
            .update(Buffer.from([1, 2, 3]))
            .digest('hex'),
        });
      if (url.pathname.startsWith('/upload/drive/v3/files'))
        return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/session' } });
      if (url.pathname === '/drive/v3/files' && init?.method === 'POST') {
        const metadata = JSON.parse(stringBody(init.body)) as Record<string, unknown>;
        created.push(metadata);
        return Response.json({ id: `folder-${String(nextId++)}` });
      }
      if (url.pathname === '/drive/v3/files') return Response.json({ files: [] });
      throw new Error(`Unexpected Drive request ${url.toString()}`);
    };
    const custodyDir = mkdtempSync(join(tmpdir(), 'overlook-interop-drive-custody-'));
    const tokenStore = new GoogleDriveTokenStore({
      dataDir: custodyDir,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString('utf8'),
      },
    });
    tokenStore.save({
      clientId: 'desktop.apps.googleusercontent.com',
      refreshToken: 'sealed',
      connectedAt: '2026-07-16T00:00:00.000Z',
    });
    const auth = new GoogleDriveAuthClient({
      clientId: () => 'desktop.apps.googleusercontent.com',
      tokenStore,
      fetchImpl,
    });
    auth.seed('access', 3600);
    const paths = new GoogleDrivePathStore(mkdtempSync(join(tmpdir(), 'overlook-interop-drive-')));
    paths.setOverlookFolderId('backup-root');
    const store = createGoogleDriveInteropStore({
      auth,
      paths,
      fetchImpl,
    });
    await store.put('object.bin', Buffer.from([1, 2, 3]));
    assert.equal(created[0]?.['name'], 'Overlook Interop');
    assert.deepEqual(created[0]?.['appProperties'], {
      overlookOwner: 'qwts-overlook-interop-v1',
      overlookPathHash: createHash('sha256').update('overlook-root').digest('hex'),
    });
    assert.equal('listLibraries' in store, false);
    assert.equal(paths.overlookFolderId(), 'backup-root', 'interop must not reuse or overwrite the backup root cache');
  });
});

describe('signed iCloud native host (#335)', () => {
  test('allows only the released extension and file references in bounded frames', async () => {
    const calls: string[] = [];
    const authority = {
      status: () => Promise.resolve({ available: true }),
      putFile: (path: string, source: string) => {
        calls.push(`${path}:${source}`);
        return Promise.resolve({ stored: true });
      },
      materializeFile: () => Promise.resolve({}),
      list: () => Promise.resolve({ entries: [] }),
      delete: () => Promise.resolve({}),
      quota: () => Promise.resolve({ usedBytes: 0, totalBytes: null }),
      verify: () => Promise.resolve({ sha256: randomBytes(32).toString('hex'), bytes: 0 }),
    };
    const host = new ICloudNativeHost({
      expectedExtensionId: RELEASED_EXTENSION_ID,
      platform: 'darwin',
      signed: true,
      entitled: true,
      iCloudAvailable: true,
      authority,
    });
    assert.equal(
      (
        await host.handle({
          schemaVersion: 1,
          operation: 'put-file',
          extensionId: RELEASED_EXTENSION_ID,
          path: 'pairings/a/object.bin',
          sourceFile: 'source-reference-1',
        })
      ).ok,
      true,
    );
    assert.deepEqual(calls, ['pairings/a/object.bin:source-reference-1']);
    assert.equal(
      (
        await host.handle({
          schemaVersion: 1,
          operation: 'put-file',
          extensionId: RELEASED_EXTENSION_ID,
          sourceFile: 'source-reference-1',
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await host.handle({
          schemaVersion: 1,
          operation: 'materialize-file',
          extensionId: RELEASED_EXTENSION_ID,
          destinationFile: 'destination-reference-1',
        })
      ).ok,
      false,
    );
    assert.deepEqual(calls, ['pairings/a/object.bin:source-reference-1']);
    assert.equal((await host.handle({ schemaVersion: 1, operation: 'status', extensionId: 'wrong' })).ok, false);
    assert.equal((await host.handle({ schemaVersion: 1, operation: 'status', extensionId: RELEASED_EXTENSION_ID, bytes: [1] })).ok, false);
    assert.deepEqual(nativeHostManifest('/Applications/Overlook.app/Contents/MacOS/Overlook', RELEASED_EXTENSION_ID).allowed_origins, [
      `chrome-extension://${RELEASED_EXTENSION_ID}/`,
    ]);
  });
});
