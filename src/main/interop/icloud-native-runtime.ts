import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { ICloudDriveAuthorityStore } from '../backup/icloud-drive/authority-store.js';
import type { ICloudDriveNativeBridge, ICloudDriveNativeStatus } from '../backup/icloud-drive/native-bridge.js';
import type { SafeStorageLike } from '../crypto/keystore.js';
import { BridgeICloudNativeAuthority } from './icloud-native-authority.js';
import { ICloudNativeHost } from './icloud-native-host.js';
import { assertAuthorizedNativeHostInvocation, type NativeHostInvocation } from './icloud-native-registration.js';
import { isLiveLocalNativeBootstrapRequest, requestLiveLocalBootstrap } from './live-local-native.js';
import { runNativeMessage } from './native-messaging.js';

export interface RunICloudNativeHostOptions {
  readonly invocation: NativeHostInvocation;
  readonly extensionId: string | null;
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly profileDirectory: string;
  readonly safeStorage: SafeStorageLike;
  readonly bridge: ICloudDriveNativeBridge;
  readonly input: Readable;
  readonly output: Writable;
  readonly statusTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
}

function hostAvailability(status: ICloudDriveNativeStatus): { readonly entitled: boolean; readonly available: boolean } {
  return {
    entitled: status.reason !== 'unentitled',
    available: status.available,
  };
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('native host operation timed out')), timeoutMs);
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

/** Executes one sendNativeMessage request and exits after the bridge drains.
 * The ordinary desktop composition root is never started in this mode. */
export async function runICloudNativeHost(options: RunICloudNativeHostOptions): Promise<void> {
  const authority = new BridgeICloudNativeAuthority({
    bridge: options.bridge,
    accountAuthority: new ICloudDriveAuthorityStore(
      options.safeStorage,
      join(options.profileDirectory, 'interop', 'provider-auth', 'icloud-drive'),
    ),
    stagingDirectory: join(options.profileDirectory, 'interop', 'native-staging'),
  });
  try {
    await runNativeMessage(options.input, options.output, async (value) => {
      assertAuthorizedNativeHostInvocation(options.invocation);
      const expectedExtensionId = options.extensionId ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      if (isLiveLocalNativeBootstrapRequest(value)) {
        return {
          schemaVersion: 1,
          ok: true,
          result: await requestLiveLocalBootstrap(value, {
            platform: options.platform,
            packaged: options.packaged,
            profileDirectory: options.profileDirectory,
            expectedExtensionId,
          }),
        };
      }
      const availability = await withDeadline(options.bridge.status(), options.statusTimeoutMs ?? 5_000)
        .then(hostAvailability)
        .catch(() => ({ entitled: false, available: false }));
      const host = new ICloudNativeHost({
        expectedExtensionId,
        platform: options.platform,
        signed: options.packaged,
        entitled: availability.entitled,
        iCloudAvailable: availability.available,
        authority,
      });
      return host.handle(value);
    });
  } finally {
    await withDeadline(options.bridge.drain(), options.drainTimeoutMs ?? 1_000).catch(() => undefined);
  }
}
