import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';

import { DeterministicICloudDriveBridge } from '../../src/main/backup/icloud-drive/deterministic-bridge.js';
import { BridgeICloudNativeAuthority } from '../../src/main/interop/icloud-native-authority.js';
import { nativeHostInvocation, registerICloudNativeHost } from '../../src/main/interop/icloud-native-registration.js';
import { readNativeMessage, runNativeMessage } from '../../src/main/interop/native-messaging.js';
import { runICloudNativeHost } from '../../src/main/interop/production-runtime.js';
import { INTEROP_CONTROL_FRAME_BYTES, InteropTransportError } from '../../src/main/interop/transport.js';
import { OVERLOOK_ICLOUD_NATIVE_HOST } from '../../src/shared/app-identity.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

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

describe('native messaging framing (#467)', () => {
  test('reads one bounded frame and writes one bounded response', async () => {
    const input = { schemaVersion: 1, operation: 'status', extensionId: EXTENSION_ID };
    assert.deepEqual(await readNativeMessage(Readable.from([requestFrame(input)])), input);
    const openInput = new PassThrough();
    openInput.write(requestFrame(input));
    assert.deepEqual(await readNativeMessage(openInput), input);
    openInput.destroy();

    const output = new PassThrough();
    const captured = buffer(output);
    await runNativeMessage(Readable.from([requestFrame(input)]), output, () =>
      Promise.resolve({ schemaVersion: 1, ok: true, result: { available: true } }),
    );
    output.end();
    assert.deepEqual(decodeFrame(await captured), {
      schemaVersion: 1,
      ok: true,
      result: { available: true },
    });
  });

  test('rejects malformed, oversized, trailing, and byte-bearing frames', async () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(INTEROP_CONTROL_FRAME_BYTES + 1);
    await assert.rejects(readNativeMessage(Readable.from([oversized])), InteropTransportError);
    await assert.rejects(readNativeMessage(Readable.from([Buffer.from([1, 0, 0, 0, 123, 125])])), InteropTransportError);
    await assert.rejects(readNativeMessage(Readable.from([requestFrame({ bytes: [1] })])), InteropTransportError);
    await assert.rejects(readNativeMessage(Readable.from([Buffer.from([3, 0, 0, 0, 123, 125, 0])])), InteropTransportError);
  });
});

describe('iCloud native host registration (#467)', () => {
  test('repairs macOS Chromium manifests with the signed app executable and exact origin', async () => {
    const appSupport = mkdtempSync(join(tmpdir(), 'overlook-native-host-'));
    const executablePath = '/Applications/Overlook.app/Contents/MacOS/Overlook';
    const installed = await registerICloudNativeHost({
      platform: 'darwin',
      packaged: true,
      applicationSupportDirectory: appSupport,
      executablePath,
      extensionId: EXTENSION_ID,
    });
    assert.equal(installed.length, 4);
    const manifest = JSON.parse(await readFile(installed[0] as string, 'utf8')) as Record<string, unknown>;
    assert.equal(manifest['name'], OVERLOOK_ICLOUD_NATIVE_HOST);
    assert.equal(manifest['path'], executablePath);
    assert.deepEqual(manifest['allowed_origins'], [`chrome-extension://${EXTENSION_ID}/`]);
    assert.deepEqual(
      await registerICloudNativeHost({
        platform: 'darwin',
        packaged: true,
        applicationSupportDirectory: appSupport,
        executablePath,
        extensionId: EXTENSION_ID,
      }),
      installed,
    );
  });

  test('stays disabled outside configured packaged macOS and distinguishes wrong origins', async () => {
    const options = {
      applicationSupportDirectory: '/unused',
      executablePath: '/Applications/Overlook.app/Contents/MacOS/Overlook',
      extensionId: EXTENSION_ID,
    };
    assert.deepEqual(await registerICloudNativeHost({ ...options, platform: 'linux', packaged: true }), []);
    assert.deepEqual(await registerICloudNativeHost({ ...options, platform: 'darwin', packaged: false }), []);
    assert.equal(nativeHostInvocation(['Overlook'], EXTENSION_ID).requested, false);
    assert.equal(nativeHostInvocation(['Overlook', `chrome-extension://${EXTENSION_ID}/`], EXTENSION_ID).authorized, true);
    assert.equal(
      nativeHostInvocation(['Overlook', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], EXTENSION_ID).authorized,
      false,
    );
  });
});

describe('production iCloud native-host boundary (#467)', () => {
  test('rejects the process origin before touching iCloud authority', async () => {
    const input = { schemaVersion: 1, operation: 'status', extensionId: EXTENSION_ID };
    const output = new PassThrough();
    const captured = buffer(output);
    const bridge = new DeterministicICloudDriveBridge();
    await runICloudNativeHost({
      invocation: nativeHostInvocation(['Overlook', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], EXTENSION_ID),
      extensionId: EXTENSION_ID,
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
  });
});

describe('iCloud native authority (#467)', () => {
  test('keeps paths namespaced, file references opaque, and account custody pinned', async () => {
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
    await authority.putFile('pairings/p/transfers/t/object.bin', 'source-reference-1');
    assert.ok(bridge.objects.has('Overlook-Interop/v1/pairings/p/transfers/t/object.bin'));
    assert.deepEqual(await authority.verify('pairings/p/transfers/t/object.bin'), {
      sha256: '305531dcc50ebca31cf1d5b31e9fc76ed51f66b3b6dd5a030c6539ae6532f979',
      bytes: 10,
    });
    bridge.changeAccount();
    await assert.rejects(
      authority.delete('pairings/p/transfers/t/object.bin'),
      (error: unknown) => error instanceof InteropTransportError && error.code === 'auth-expired',
    );
  });
});
