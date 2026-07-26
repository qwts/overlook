import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';

import { GoogleDriveAuthClient } from '../../src/main/backup/google-drive/auth-client.js';
import { GoogleDrivePathStore } from '../../src/main/backup/google-drive/path-store.js';
import { GoogleDriveTokenStore } from '../../src/main/backup/google-drive/token-store.js';
import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import type { PCloudAuthRecord } from '../../src/main/backup/pcloud/token-store.js';
import { BridgeICloudNativeAuthority } from '../../src/main/interop/icloud-native-authority.js';
import { ICloudNativeHost, nativeHostManifest } from '../../src/main/interop/icloud-native-host.js';
import { runICloudNativeHost } from '../../src/main/interop/icloud-native-runtime.js';
import { nativeHostInvocation, registerICloudNativeHost } from '../../src/main/interop/icloud-native-registration.js';
import { encodeNativeMessage, readNativeMessage, runNativeMessage } from '../../src/main/interop/native-messaging.js';
import {
  EncryptedInteropTransport,
  INTEROP_CONTROL_FRAME_BYTES,
  InteropTransportError,
  createGoogleDriveInteropStore,
  createPCloudInteropStore,
  type InteropObjectPage,
  type InteropObjectStore,
} from '../../src/main/interop/transport.js';
import { OVERLOOK_ICLOUD_NATIVE_HOST } from '../../src/shared/app-identity.js';

const SCOPE = {
  pairingId: 'f03e92fd-ad4a-41e6-aeaf-a65abde4c853',
  transferId: '35d06972-7453-4c53-8a32-e531e4ab43ed',
};
const RELEASED_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

function requestFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function decodeFrame(value: Buffer): unknown {
  const length = value.readUInt32LE(0);
  assert.equal(value.length, length + 4);
  return JSON.parse(value.subarray(4).toString('utf8')) as unknown;
}

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

describe('native messaging production framing (#467)', () => {
  test('reads one open bounded frame and flushes one bounded response', async () => {
    const input = { schemaVersion: 1, operation: 'status', extensionId: RELEASED_EXTENSION_ID };
    const openInput = new PassThrough();
    const frame = requestFrame(input);
    openInput.write(frame.subarray(0, 4));
    openInput.write(frame.subarray(4));
    assert.deepEqual(await readNativeMessage(openInput), input);
    openInput.destroy();

    const output = new PassThrough();
    const captured = buffer(output);
    await runNativeMessage(Readable.from([frame]), output, () =>
      Promise.resolve({ schemaVersion: 1, ok: true, result: { available: true } }),
    );
    output.end();
    assert.deepEqual(decodeFrame(await captured), {
      schemaVersion: 1,
      ok: true,
      result: { available: true },
    });
    assert.throws(
      () => encodeNativeMessage({ schemaVersion: 1, ok: true, result: 'x'.repeat(INTEROP_CONTROL_FRAME_BYTES) }),
      InteropTransportError,
    );
  });

  test('rejects malformed, truncated, oversized, trailing, and byte-bearing frames', async () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(INTEROP_CONTROL_FRAME_BYTES + 1);
    for (const input of [
      Buffer.alloc(0),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([1, 0, 0, 0, 123, 125]),
      requestFrame({ bytes: [1] }),
      Buffer.from([3, 0, 0, 0, 123, 125, 0]),
      oversized,
    ]) {
      await assert.rejects(readNativeMessage(Readable.from([input])), InteropTransportError);
    }
    const output = new PassThrough();
    const captured = buffer(output);
    await runNativeMessage(Readable.from([requestFrame({})]), output, () => {
      throw new InteropTransportError('offline', 'offline', true);
    });
    output.end();
    assert.deepEqual(decodeFrame(await captured), { schemaVersion: 1, ok: false, code: 'offline', retryable: true });
  });
});

describe('iCloud native host registration and production boundary (#467)', () => {
  test('repairs manifests and stays disabled outside configured packaged macOS', async () => {
    const appSupport = mkdtempSync(join(tmpdir(), 'overlook-native-host-'));
    const executablePath = '/Applications/Overlook.app/Contents/MacOS/Overlook';
    const options = {
      platform: 'darwin' as const,
      packaged: true,
      applicationSupportDirectory: appSupport,
      executablePath,
      extensionId: RELEASED_EXTENSION_ID,
    };
    const installed = await registerICloudNativeHost(options);
    assert.equal(installed.length, 4);
    const manifest = JSON.parse(await readFile(installed[0] as string, 'utf8')) as Record<string, unknown>;
    assert.equal(manifest['name'], OVERLOOK_ICLOUD_NATIVE_HOST);
    assert.equal(manifest['path'], executablePath);
    assert.deepEqual(manifest['allowed_origins'], [`chrome-extension://${RELEASED_EXTENSION_ID}/`]);
    await writeFile(installed[0] as string, '{}');
    assert.deepEqual(await registerICloudNativeHost(options), installed);
    assert.match(await readFile(installed[0] as string, 'utf8'), /allowed_origins/u);
    assert.deepEqual(await registerICloudNativeHost({ ...options, platform: 'linux' }), []);
    assert.deepEqual(await registerICloudNativeHost({ ...options, packaged: false }), []);
    assert.deepEqual(await registerICloudNativeHost({ ...options, extensionId: null }), []);
  });

  test('continues registration when one browser profile is damaged', async () => {
    const appSupport = mkdtempSync(join(tmpdir(), 'overlook-native-host-'));
    await writeFile(join(appSupport, 'Google'), 'occupied');
    const installed = await registerICloudNativeHost({
      platform: 'darwin',
      packaged: true,
      applicationSupportDirectory: appSupport,
      executablePath: '/Applications/Overlook.app/Contents/MacOS/Overlook',
      extensionId: RELEASED_EXTENSION_ID,
    });
    assert.equal(installed.length, 3);
    assert.ok(installed.every((path) => !path.includes('/Google/Chrome/')));
  });

  test('gates iCloud authority on the process origin before native access', async () => {
    const input = { schemaVersion: 1, operation: 'status', extensionId: RELEASED_EXTENSION_ID };
    const output = new PassThrough();
    const captured = buffer(output);
    const bridge = new DeterministicICloudDriveBridge();
    await runICloudNativeHost({
      invocation: nativeHostInvocation(['Overlook', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], RELEASED_EXTENSION_ID),
      extensionId: RELEASED_EXTENSION_ID,
      platform: 'darwin',
      packaged: true,
      profileDirectory: mkdtempSync(join(tmpdir(), 'overlook-native-profile-')),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8'),
      },
      bridge,
      input: Readable.from([requestFrame(input)]),
      output,
    });
    output.end();
    assert.deepEqual(decodeFrame(await captured), {
      schemaVersion: 1,
      ok: false,
      code: 'unsupported',
      retryable: false,
    });
    assert.deepEqual(bridge.calls, []);
    assert.equal(nativeHostInvocation(['Overlook'], RELEASED_EXTENSION_ID).requested, false);
    assert.equal(
      nativeHostInvocation(['Overlook', `chrome-extension://${RELEASED_EXTENSION_ID}/`], RELEASED_EXTENSION_ID).authorized,
      true,
    );
  });

  test('composes the authorized host', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'overlook-native-profile-'));
    const output = new PassThrough();
    const captured = buffer(output);
    const bridge = new DeterministicICloudDriveBridge();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8'),
    };
    await runICloudNativeHost({
      invocation: nativeHostInvocation(['Overlook', `chrome-extension://${RELEASED_EXTENSION_ID}/`], RELEASED_EXTENSION_ID),
      extensionId: RELEASED_EXTENSION_ID,
      platform: 'darwin',
      packaged: true,
      profileDirectory: profile,
      safeStorage,
      bridge,
      input: Readable.from([requestFrame({ schemaVersion: 1, operation: 'status', extensionId: RELEASED_EXTENSION_ID })]),
      output,
    });
    output.end();
    assert.deepEqual(decodeFrame(await captured), {
      schemaVersion: 1,
      ok: true,
      result: { available: true, provider: 'icloud' },
    });
    assert.deepEqual(bridge.calls, ['status', 'status']);
  });

  test('fails closed and exits when native status and drain do not settle', async () => {
    const output = new PassThrough();
    const captured = buffer(output);
    const bridge = new DeterministicICloudDriveBridge();
    bridge.status = () => new Promise(() => undefined);
    bridge.drain = () => new Promise(() => undefined);
    await runICloudNativeHost({
      invocation: nativeHostInvocation(['Overlook', `chrome-extension://${RELEASED_EXTENSION_ID}/`], RELEASED_EXTENSION_ID),
      extensionId: RELEASED_EXTENSION_ID,
      platform: 'darwin',
      packaged: true,
      profileDirectory: mkdtempSync(join(tmpdir(), 'overlook-native-profile-')),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8'),
      },
      bridge,
      input: Readable.from([requestFrame({ schemaVersion: 1, operation: 'status', extensionId: RELEASED_EXTENSION_ID })]),
      output,
      statusTimeoutMs: 5,
      drainTimeoutMs: 5,
    });
    output.end();
    assert.deepEqual(decodeFrame(await captured), {
      schemaVersion: 1,
      ok: false,
      code: 'unsupported',
      retryable: false,
    });
  });
});

describe('iCloud native authority production adapter (#467)', () => {
  test('namespaces all operations, keeps opaque staging, and pins account custody', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'overlook-native-staging-'));
    const bridge = new DeterministicICloudDriveBridge();
    let account: string | null = null;
    const authority = new BridgeICloudNativeAuthority({
      bridge,
      accountAuthority: {
        load: () => account,
        save: (value) => {
          account = value;
        },
      },
      stagingDirectory: staging,
    });
    await writeFile(join(staging, 'source-reference-1.bin'), Buffer.from('ciphertext'));
    assert.deepEqual(await authority.status(), { available: true, provider: 'icloud' });
    assert.deepEqual(await authority.putFile('pairings/p/transfers/t/object.bin', 'source-reference-1'), { stored: true });
    assert.deepEqual(await authority.list('pairings/p/transfers/t', null), {
      entries: [
        {
          path: 'pairings/p/transfers/t/object.bin',
          bytes: 10,
          modifiedAt: '2026-07-21T00:00:01.000Z',
          downloaded: true,
          conflicted: false,
        },
      ],
      nextCursor: null,
    });
    assert.deepEqual(await authority.verify('pairings/p/transfers/t/object.bin'), {
      sha256: '305531dcc50ebca31cf1d5b31e9fc76ed51f66b3b6dd5a030c6539ae6532f979',
      bytes: 10,
    });
    assert.deepEqual(await authority.materializeFile('pairings/p/transfers/t/object.bin', 'destination-reference-1'), {
      materialized: true,
      fileReference: 'destination-reference-1',
    });
    assert.deepEqual(await readFile(join(staging, 'destination-reference-1.bin')), Buffer.from('ciphertext'));
    assert.deepEqual(await authority.quota(), { usedBytes: 0, totalBytes: null });
    assert.deepEqual(await authority.delete('pairings/p/transfers/t/object.bin'), { deleted: true });
    await assert.rejects(authority.putFile('pairings/p/transfers/t/missing.bin', 'missing-reference'), InteropTransportError);
    bridge.changeAccount();
    const accountExpired = (error: unknown): boolean =>
      error instanceof InteropTransportError && error.code === 'auth-expired' && !error.retryable;
    await assert.rejects(authority.quota(), accountExpired);
    await assert.rejects(authority.verify('pairings/p/transfers/t/object.bin'), accountExpired);
    await assert.rejects(authority.delete('pairings/p/transfers/t/object.bin'), accountExpired);
  });
});
